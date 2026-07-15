import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type {
  DomainEvent,
  PaymentSucceededEvent,
  SubscriptionCreatedEvent,
  UnknownPaymentQuarantinedEvent,
} from '@billing-service/shared';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { Queue } from '@/infra/queue/service.js';
import type { EnqueueInput, EnqueueResult } from '@/infra/queue/store.js';
import {
  Charge,
  type Match,
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
  type ChargeApplier,
  type ChargeMatcher,
  RebindPayload,
} from '@/modules/charge/contracts.js';
import {
  makeChargeRepo,
  type ChargeRepo,
} from '@/modules/charge/data-access.js';
import { Outbox } from '@/modules/outbox/domain.js';

/**
 * Charge pipeline (FR-007). A source `ingest`s a normalized charge onto the queue;
 * the `payment_event_received` handler runs it through: upsert (idempotent on the
 * source key) -> match -> record payment + emit, or quarantine + emit (FR-009).
 * Every write is idempotent and every emitted event has a deterministic id, so a
 * handler retry never doubles a payment or an outgoing event (AC2).
 */

/** Deterministic event id from the source key, so replays dedupe in the outbox. */
const eventId = (idemKey: string, suffix: string): string =>
  `evt_${idemKey}:${suffix}`;

/** payment_succeeded envelope for a matched incoming charge (docs/07). */
export const paymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): PaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: {
    amount: event.amount,
    currency: event.currency,
    method: match.method,
    period: match.period,
    source: event.source,
  },
});

/** subscription_created envelope for a brand-new gateway subscription (docs/07). */
export const subscriptionCreated = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): SubscriptionCreatedEvent => ({
  id: eventId(event.idemKey, 'subscription'),
  name: 'subscription_created',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: {
    amount: event.amount,
    currency: event.currency,
    period: match.period,
  },
});

/** unknown_payment_quarantined envelope — externalUserId is null by definition. */
export const quarantined = (
  event: Charge,
  quarantineId: string,
  incomingEventId: string,
): UnknownPaymentQuarantinedEvent => ({
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

/** payment_succeeded envelope for an operator-bound quarantine (FR-009). Without
 * a real subscription yet, the aggregate id falls back to the incoming event. */
export const boundPaymentSucceeded = (
  event: Charge,
  bind: RebindPayload,
): PaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: bind.externalUserId,
  aggregateId: bind.subscriptionId ?? `bound:${bind.incomingEventId}`,
  payload: {
    amount: event.amount,
    currency: event.currency,
    method: bind.method,
    period: bind.period,
    source: event.source,
  },
});

interface IngestDeps {
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<EnqueueResult, SqlError.SqlError>;
}

/** Entry point for any source: enqueue the normalized charge (idempotent by key). */
export const ingest =
  (deps: IngestDeps) =>
  (event: Charge): Effect.Effect<void, SqlError.SqlError> =>
    deps
      .enqueue({
        messageType: PAYMENT_EVENT_RECEIVED,
        idemKey: event.idemKey,
        payload: event,
      })
      .pipe(Effect.asVoid);

interface HandleDeps {
  readonly repo: ChargeRepo;
  readonly matcher: ChargeMatcher;
  readonly applier: ChargeApplier;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const process = (deps: HandleDeps, event: Charge) =>
  Effect.gen(function* () {
    const incomingId = yield* deps.repo.upsertIncomingCharge(event);
    const match = yield* deps.matcher(event);
    if (!match.matched) {
      const quarantineId = yield* deps.repo.upsertQuarantine(incomingId);
      yield* deps.repo.setMatchResult(incomingId, 'quarantined');
      yield* deps.publish(quarantined(event, quarantineId, incomingId));
      return;
    }
    const applied = yield* deps.applier(event, match);
    yield* deps.repo.insertPayment({
      incomingEventId: incomingId,
      subscriptionId: applied.subscriptionId,
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      source: event.source,
      occurredAt: event.occurredAt,
    });
    yield* deps.repo.setMatchResult(incomingId, 'matched');
    if (applied.created) {
      yield* deps.publish(
        subscriptionCreated(event, match, applied.subscriptionId),
      );
    }
    yield* deps.publish(paymentSucceeded(event, match, applied.subscriptionId));
  });

/** The `payment_event_received` handler: decode the queue payload, then process. */
export const handleChargeEvent =
  (deps: HandleDeps) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(Charge)(payload).pipe(
      Effect.flatMap((event) => process(deps, event)),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(
          `invalid ${PAYMENT_EVENT_RECEIVED} payload: ${error.message}`,
        ),
      ),
    );

/**
 * Reprocess an operator-bound quarantine (FR-009). The operator binds a SPECIFIC
 * incoming charge by id: one user may have several quarantined events at once (e.g.
 * two failed attempts and one success), so a human — not a heuristic — chooses which
 * to bind. Load that event, record the payment against the operator-supplied user,
 * resolve the quarantine, and emit payment_succeeded (the matched path, match supplied
 * by hand). Idempotent (payment ON CONFLICT, deterministic event id) so replays are
 * safe.
 */
const rebind =
  (deps: HandleDeps) =>
  (bind: RebindPayload): Effect.Effect<void, SqlError.SqlError> =>
    Effect.gen(function* () {
      const found = yield* deps.repo.getIncomingChargeById(bind.incomingEventId);
      if (Option.isNone(found)) {
        return; // incoming charge vanished — nothing to reprocess
      }
      const event = found.value;
      yield* deps.repo.insertPayment({
        incomingEventId: bind.incomingEventId,
        subscriptionId: bind.subscriptionId,
        externalUserId: bind.externalUserId,
        amount: event.amount,
        currency: event.currency,
        source: event.source,
        occurredAt: event.occurredAt,
      });
      yield* deps.repo.setMatchResult(bind.incomingEventId, 'matched');
      yield* deps.repo.resolveQuarantine(
        bind.incomingEventId,
        bind.subscriptionId,
      );
      yield* deps.publish(boundPaymentSucceeded(event, bind));
    });

/** The `payment_rebind` handler: decode the operator's bind payload, then rebind. */
export const rebindFromPayload =
  (deps: HandleDeps) =>
  (payload: unknown): Effect.Effect<void, SqlError.SqlError> =>
    Schema.decodeUnknown(RebindPayload)(payload).pipe(
      Effect.flatMap((bind) => rebind(deps)(bind)),
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${PAYMENT_REBIND} payload: ${error.message}`),
      ),
    );

export interface ChargePipelineService {
  readonly ingest: (
    event: Charge,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly handleFromPayload: (
    payload: unknown,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly rebindFromPayload: (
    payload: unknown,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export class ChargePipeline extends Context.Tag('PaymentPipeline')<
  ChargePipeline,
  ChargePipelineService
>() {}

/**
 * The pipeline as a layer, given how to build its matcher and applier from `sql`.
 * The matcher/applier are plain functions the pipeline calls — they are composed in
 * the composition root (runtime) and passed in, not resolved as separate services,
 * so the pipeline needs no context beyond its real resources (Sql, Outbox, Queue).
 */
export const makeChargePipelineLayer = (
  makeMatcher: (sql: SqlClient.SqlClient) => ChargeMatcher,
  makeApplier: (sql: SqlClient.SqlClient) => ChargeApplier,
) =>
  Layer.effect(
    ChargePipeline,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* Outbox;
      const queue = yield* Queue;
      const repo = makeChargeRepo(sql);
      const handleDeps = {
        repo,
        matcher: makeMatcher(sql),
        applier: makeApplier(sql),
        publish: outbox.publish,
      };
      return {
        ingest: ingest({ enqueue: queue.enqueue }),
        handleFromPayload: handleChargeEvent(handleDeps),
        rebindFromPayload: rebindFromPayload(handleDeps),
      };
    }),
  );
