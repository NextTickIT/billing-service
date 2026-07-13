import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type { DomainEvent } from '@billing-service/shared';
import { Context, Effect, Layer, Schema } from 'effect';

import { Queue } from '@/infra/queue/service.js';
import type { EnqueueInput, EnqueueResult } from '@/infra/queue/store.js';
import {
  IncomingPaymentEvent,
  type MatchResult,
  PAYMENT_EVENT_RECEIVED,
  PaymentMatcher,
  type PaymentMatcherService,
} from '@/modules/payments/contracts.js';
import {
  makePaymentsRepo,
  type PaymentsRepo,
} from '@/modules/payments/data-access.js';
import { Outbox } from '@/modules/outbox/domain.js';

/**
 * Payment pipeline (FR-007). A source `ingest`s a normalized event onto the queue;
 * the `payment_event_received` handler runs it through: upsert (idempotent on the
 * source key) -> match -> record payment + emit, or quarantine + emit (FR-009).
 * Every write is idempotent and every emitted event has a deterministic id, so a
 * handler retry never doubles a payment or an outgoing event (AC2).
 */

/** Deterministic event id from the source key, so replays dedupe in the outbox. */
const eventId = (idemKey: string, suffix: string): string =>
  `evt_${idemKey}:${suffix}`;

/** payment_succeeded envelope for a matched incoming event (docs/07). */
export const paymentSucceeded = (
  event: IncomingPaymentEvent,
  match: Extract<MatchResult, { matched: true }>,
): DomainEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: match.subscriptionId,
  payload: {
    amount: event.amount,
    currency: event.currency,
    method: match.method,
    period: match.period,
    source: event.source,
  },
});

/** unknown_payment_quarantined envelope — externalUserId is null by definition. */
export const quarantined = (
  event: IncomingPaymentEvent,
  quarantineId: string,
  incomingEventId: string,
): DomainEvent => ({
  id: eventId(event.idemKey, 'quarantined'),
  name: 'unknown_payment_quarantined',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: null,
  aggregateId: quarantineId,
  payload: {
    quarantineId,
    incomingEventId,
    source: event.source,
    externalRef: event.externalRef,
    amount: event.amount,
    currency: event.currency,
  },
});

interface IngestDeps {
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<EnqueueResult, SqlError.SqlError>;
}

/** Entry point for any source: enqueue the normalized event (idempotent by key). */
export const ingest =
  (deps: IngestDeps) =>
  (event: IncomingPaymentEvent): Effect.Effect<void, SqlError.SqlError> =>
    deps
      .enqueue({
        messageType: PAYMENT_EVENT_RECEIVED,
        idemKey: event.idemKey,
        payload: event,
      })
      .pipe(Effect.asVoid);

interface HandleDeps {
  readonly repo: PaymentsRepo;
  readonly matcher: PaymentMatcherService;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const process = (deps: HandleDeps, event: IncomingPaymentEvent) =>
  Effect.gen(function* () {
    const incomingId = yield* deps.repo.upsertIncomingEvent(event);
    const match = yield* deps.matcher.match(event);
    if (match.matched) {
      yield* deps.repo.insertPayment({
        incomingEventId: incomingId,
        subscriptionId: match.subscriptionId,
        externalUserId: match.externalUserId,
        amount: event.amount,
        currency: event.currency,
        source: event.source,
        occurredAt: event.occurredAt,
      });
      yield* deps.repo.setMatchResult(incomingId, 'matched');
      yield* deps.publish(paymentSucceeded(event, match));
      return;
    }
    const quarantineId = yield* deps.repo.upsertQuarantine(incomingId);
    yield* deps.repo.setMatchResult(incomingId, 'quarantined');
    yield* deps.publish(quarantined(event, quarantineId, incomingId));
  });

/** The `payment_event_received` handler: decode the queue payload, then process. */
export const handlePaymentEvent =
  (deps: HandleDeps) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(IncomingPaymentEvent)(payload).pipe(
      Effect.flatMap((event) => process(deps, event)),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(
          `invalid ${PAYMENT_EVENT_RECEIVED} payload: ${error.message}`,
        ),
      ),
    );

export interface PaymentPipelineService {
  readonly ingest: (
    event: IncomingPaymentEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly handleFromPayload: (
    payload: unknown,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class PaymentPipeline extends Context.Tag('PaymentPipeline')<
  PaymentPipeline,
  PaymentPipelineService
>() {}

export const PaymentPipelineLive = Layer.effect(
  PaymentPipeline,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const matcher = yield* PaymentMatcher;
    const outbox = yield* Outbox;
    const queue = yield* Queue;
    const repo = makePaymentsRepo(sql);
    return {
      ingest: ingest({ enqueue: queue.enqueue }),
      handleFromPayload: handlePaymentEvent({
        repo,
        matcher,
        publish: outbox.publish,
      }),
    };
  }),
);
