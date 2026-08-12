import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type {
  CardChangeFailedEvent,
  CardChangeSucceededEvent,
  DomainEvent,
  InitialPaymentFailedEvent,
  InitialPaymentSucceededEvent,
  PaymentCreatedEvent,
  RecurringPaymentSucceededEvent,
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

/** Shared success payload for the initial/recurring variants (docs/07). */
const succeededPayload = (event: Charge, match: Match) => ({
  amount: event.amount,
  currency: event.currency,
  method: match.method,
  period: match.period,
  source: event.source,
});

/** initial_payment_succeeded — a first checkout payment (match kind 'checkout'). */
export const initialPaymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): InitialPaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'initial_payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: succeededPayload(event, match),
});

/** recurring_payment_succeeded — a renewal charge (match kind 'recurring'). */
export const recurringPaymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): RecurringPaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'recurring_payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: succeededPayload(event, match),
});

/** Pick the success variant from the match kind (checkout = initial, else recurring). */
const paymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): InitialPaymentSucceededEvent | RecurringPaymentSucceededEvent =>
  match.kind === 'checkout'
    ? initialPaymentSucceeded(event, match, subscriptionId)
    : recurringPaymentSucceeded(event, match, subscriptionId);

/** The provider decline reason for a failed charge (raw payload; string or code). */
const declineReason = (payload: Record<string, unknown>): string => {
  const value = payload['reason'] ?? payload['reasonCode'];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : 'declined';
};

/** initial_payment_failed — a declined first checkout for a known session (FR-003). */
export const initialPaymentFailed = (
  event: Charge,
  match: Match,
): InitialPaymentFailedEvent => ({
  id: eventId(event.idemKey, 'failed'),
  name: 'initial_payment_failed',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: match.subscriptionId ?? event.externalRef,
  payload: {
    amount: event.amount,
    currency: event.currency,
    method: match.method,
    period: match.period,
    reason: declineReason(event.payload),
    source: event.source,
  },
});

/** payment_created envelope for a brand-new gateway payment (docs/07). */
export const paymentCreated = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): PaymentCreatedEvent => ({
  id: eventId(event.idemKey, 'subscription'),
  name: 'payment_created',
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

/**
 * Success envelope for an operator-bound quarantine (FR-009). A bind reconciles a
 * previously-unknown (usually legacy/migration-tail) payment to a user, so it maps
 * to `recurring_payment_succeeded` — never the "welcome" initial flow. Without a real
 * subscription yet, the aggregate id falls back to the incoming event.
 */
export const boundPaymentSucceeded = (
  event: Charge,
  bind: RebindPayload,
): RecurringPaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'recurring_payment_succeeded',
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

/** card_change_succeeded — a card change tokenized/collected the new card (docs/23). */
export const cardChangeSucceeded = (
  event: Charge,
  match: Match,
): CardChangeSucceededEvent => ({
  id: eventId(event.idemKey, 'card_change'),
  name: 'card_change_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: match.subscriptionId ?? event.externalRef,
  payload: { method: match.method },
});

/** card_change_failed — the provider declined/errored a card change (docs/23). */
export const cardChangeFailed = (
  event: Charge,
  match: Match,
): CardChangeFailedEvent => ({
  id: eventId(event.idemKey, 'card_change_failed'),
  name: 'card_change_failed',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: match.subscriptionId ?? event.externalRef,
  payload: { reason: declineReason(event.payload) },
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

/** Record a matched, succeeded charge: apply, fix the payment, emit created?/succeeded. */
const recordMatchedSuccess = (
  deps: HandleDeps,
  event: Charge,
  match: Match,
  incomingId: string,
) =>
  Effect.gen(function* () {
    const applied = yield* deps.applier(event, match);
    yield* deps.repo.insertPayment({
      incomingEventId: incomingId,
      paymentId: applied.subscriptionId,
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      source: event.source,
      occurredAt: event.occurredAt,
    });
    yield* deps.repo.setMatchResult(incomingId, 'matched');
    if (applied.created) {
      yield* deps.publish(paymentCreated(event, match, applied.subscriptionId));
    }
    yield* deps.publish(paymentSucceeded(event, match, applied.subscriptionId));
  });

/**
 * A card-change callback (docs/23). The applier has updated the stored token (and,
 * for an owed change, advanced the existing payment — never create-or-extend, so the
 * one-active-payment invariant holds). An owed change collected real money, so it
 * records the fixation and emits `recurring_payment_succeeded` like any renewal; both
 * the verify and owed cases emit `card_change_succeeded`. A decline emits
 * `card_change_failed` and leaves the payment untouched.
 */
const recordCardChange = (
  deps: HandleDeps,
  event: Charge,
  match: Match,
  incomingId: string,
) =>
  Effect.gen(function* () {
    yield* deps.repo.setMatchResult(incomingId, 'matched');
    if (event.status !== 'succeeded') {
      yield* deps.publish(cardChangeFailed(event, match));
      return;
    }
    const applied = yield* deps.applier(event, match);
    if (match.owed === true) {
      yield* deps.repo.insertPayment({
        incomingEventId: incomingId,
        paymentId: applied.subscriptionId,
        externalUserId: match.externalUserId,
        amount: event.amount,
        currency: event.currency,
        source: event.source,
        occurredAt: event.occurredAt,
      });
      yield* deps.publish(
        recurringPaymentSucceeded(event, match, applied.subscriptionId),
      );
    }
    yield* deps.publish(cardChangeSucceeded(event, match));
  });

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
    if (match.kind === 'card_change') {
      return yield* recordCardChange(deps, event, match, incomingId);
    }
    if (event.status !== 'succeeded') {
      // Matched a known checkout session but the charge did not succeed → a declined
      // first payment (FR-003). No retry ladder — the customer re-initiates checkout;
      // the session stays open for another attempt. Recurring failures never reach the
      // pipeline (the scheduler emits them), so a matched non-success is a checkout one.
      yield* deps.repo.setMatchResult(incomingId, 'matched');
      yield* deps.publish(initialPaymentFailed(event, match));
      return;
    }
    yield* recordMatchedSuccess(deps, event, match, incomingId);
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
      const found = yield* deps.repo.getIncomingChargeById(
        bind.incomingEventId,
      );
      if (Option.isNone(found)) {
        return; // incoming charge vanished — nothing to reprocess
      }
      const event = found.value;
      yield* deps.repo.insertPayment({
        incomingEventId: bind.incomingEventId,
        paymentId: bind.subscriptionId,
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
  readonly ingest: (event: Charge) => Effect.Effect<void, SqlError.SqlError>;
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
