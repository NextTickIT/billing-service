import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type { DomainEvent } from '@billing-service/shared';
import { Cause, Context, Effect, Layer, Option, Schema } from 'effect';

import { describeError } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import type { EnqueueInput, EnqueueResult } from '@/infra/queue/store.js';
import { Sinks, type SinkError, type SinksService } from '@/infra/sinks.js';
import {
  DELIVER_EVENT,
  DeliverEventPayload,
} from '@/modules/outbox/contracts.js';
import {
  makeOutboxRepo,
  type OutboxRepo,
} from '@/modules/outbox/data-access.js';

/**
 * Outbox domain (docs/07, FR-011). `publish` stores the event and fans it out to
 * one delivery per sink atomically, idempotent on the (caller-supplied,
 * deterministic) event id so a handler retry never double-publishes. Each delivery
 * is enqueued as a `deliver_event` message, so retry/attempt history reuse the
 * durable queue (docs/09). `deliverEvent` performs one attempt and RE-FAILS on a
 * sink error, letting the queue reschedule it.
 */
interface PublishDeps {
  readonly repo: OutboxRepo;
  readonly sinks: SinksService;
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<EnqueueResult, SqlError.SqlError>;
}

export const publish =
  (deps: PublishDeps) =>
  (event: DomainEvent): Effect.Effect<void, SqlError.SqlError> =>
    deps.repo.transaction(
      Effect.gen(function* () {
        const isNew = yield* deps.repo.insertEvent(event);
        if (!isNew) {
          return; // already published — idempotent no-op
        }
        const sinks = yield* deps.sinks.all();
        yield* Effect.forEach(
          sinks,
          (sink) =>
            deps.repo.insertDelivery(event.id, sink.name).pipe(
              Effect.flatMap((deliveryId) =>
                deps.enqueue({
                  messageType: DELIVER_EVENT,
                  idemKey: deliveryId,
                  payload: { deliveryId },
                }),
              ),
            ),
          { discard: true },
        );
      }),
    );

interface DeliverDeps {
  readonly repo: OutboxRepo;
  readonly sinks: SinksService;
}

export const deliverEvent =
  (deps: DeliverDeps) =>
  (deliveryId: string): Effect.Effect<void, SqlError.SqlError | SinkError> =>
    Effect.gen(function* () {
      const found = yield* deps.repo.getDeliveryWithEvent(deliveryId);
      if (Option.isNone(found)) {
        return; // delivery vanished — nothing to do
      }
      const { sink: sinkName, status, event } = found.value;
      if (status === 'delivered') {
        return; // already delivered — idempotent
      }
      const sinks = yield* deps.sinks.all();
      const sink = sinks.find((s) => s.name === sinkName);
      if (sink === undefined) {
        // Sink no longer configured: record and stop retrying (not transient).
        yield* deps.repo.markFailed(deliveryId, {
          message: `no sink named ${sinkName}`,
        });
        return;
      }
      yield* sink.deliver(event).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => deps.repo.markDelivered(deliveryId),
          // Persist the failure for the operator, then re-fail so the queue retries.
          onFailure: (cause) =>
            deps.repo
              .markFailed(deliveryId, describeError(Cause.squash(cause)))
              .pipe(Effect.andThen(Effect.failCause(cause))),
        }),
      );
    });

/** The outbox as an injected service: `publish` for producers, `deliverFromPayload`
 * for the worker's `deliver_event` handler (validates the queue payload first). */
export interface OutboxService {
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly deliverFromPayload: (
    payload: unknown,
  ) => Effect.Effect<void, SqlError.SqlError | SinkError>;
}

export class Outbox extends Context.Tag('Outbox')<Outbox, OutboxService>() {}

export const OutboxLive = Layer.effect(
  Outbox,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sinks = yield* Sinks;
    const queue = yield* Queue;
    const repo = makeOutboxRepo(sql);
    const deliver = deliverEvent({ repo, sinks });
    return {
      publish: publish({ repo, sinks, enqueue: queue.enqueue }),
      deliverFromPayload: (payload) =>
        Schema.decodeUnknown(DeliverEventPayload)(payload).pipe(
          Effect.flatMap((p) => deliver(p.deliveryId)),
          Effect.catchTag('ParseError', (error) =>
            Effect.die(`invalid ${DELIVER_EVENT} payload: ${error.message}`),
          ),
        ),
    };
  }),
);
