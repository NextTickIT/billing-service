import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import type {
  CardChangeFailedEvent,
  CardChangeSucceededEvent,
  DomainEvent,
  InitialPaymentFailedEvent,
  InitialPaymentSucceededEvent,
  OneTimePurchaseSucceededEvent,
  PaymentCreatedEvent,
  RecurringPaymentFailedEvent,
  RecurringPaymentSucceededEvent,
  UnknownPaymentQuarantinedEvent,
} from '@billing-service/shared';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { Queue } from '@/infra/queue/service.js';
import type { EnqueueInput, EnqueueResult } from '@/infra/queue/store.js';
import {
  Charge,
  type Match,
  type RefusedCharge,
  type SettledCharge,
  settlementAnomaly,
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
import { paymentReactivated } from '@/modules/payment/cancel.js';

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

/** Shared success payload for the initial/recurring variants (docs/07). `nextPaymentDate`
 * is the next scheduled charge (null for a one-time purchase), serialized ISO-8601 to match
 * the payload-date convention (`payment_deferred.newPeriodEnd`, `charge_retry_failed`). */
const succeededPayload = (
  event: Charge,
  match: Match,
  nextPaymentDate: Date | null,
) => ({
  amount: event.amount,
  currency: event.currency,
  method: match.method,
  period: match.period,
  source: event.source,
  nextPaymentDate: nextPaymentDate?.toISOString() ?? null,
});

/** initial_payment_succeeded — a first checkout payment (match kind 'checkout'). */
export const initialPaymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
  nextPaymentDate: Date | null,
): InitialPaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'initial_payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: succeededPayload(event, match, nextPaymentDate),
});

/** recurring_payment_succeeded — a renewal charge (match kind 'recurring'). */
export const recurringPaymentSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
  nextPaymentDate: Date | null,
): RecurringPaymentSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'recurring_payment_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  payload: succeededPayload(event, match, nextPaymentDate),
});

/** one_time_purchase_succeeded — a checkout the caller marked non-recurring (a single
 * buy that is never renewed). Same facts as the other success variants. */
export const oneTimePurchaseSucceeded = (
  event: Charge,
  match: Match,
  subscriptionId: string,
): OneTimePurchaseSucceededEvent => ({
  id: eventId(event.idemKey, 'succeeded'),
  name: 'one_time_purchase_succeeded',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: subscriptionId,
  // A one-time purchase never renews, so it has no next charge date.
  payload: succeededPayload(event, match, null),
});

/**
 * Pick the success variant: a recurring renewal (non-checkout match) → recurring; a
 * checkout the caller opted out of recurrence (`match.recurring === false`) → one-time
 * purchase; a checkout that prolonged a live sub, or any manual renewal (even one paid
 * after its sub died, AC 25) → recurring; any other checkout → the initial
 * (subscription) success.
 */
const paymentSucceeded = (
  event: Charge,
  match: Match,
  applied: SettledCharge,
):
  | InitialPaymentSucceededEvent
  | RecurringPaymentSucceededEvent
  | OneTimePurchaseSucceededEvent => {
  const { subscriptionId, nextPaymentDate } = applied;
  if (
    match.kind !== 'checkout' ||
    (match.recurring !== false &&
      (applied.prolonged || match.origin === 'manual_renewal'))
  ) {
    return recurringPaymentSucceeded(
      event,
      match,
      subscriptionId,
      nextPaymentDate,
    );
  }
  return match.recurring === false
    ? oneTimePurchaseSucceeded(event, match, subscriptionId)
    : initialPaymentSucceeded(event, match, subscriptionId, nextPaymentDate);
};

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

/**
 * recurring_payment_failed — a declined prolongation: a recurring checkout whose contact
 * holds a live sub (`prolongOf`), or any manual renewal (AC 25). Nothing was written, so
 * the session stays payable. The aggregate is the live sub, else the sub the session
 * renews, else (no attribution) the session, like `initial_payment_failed`.
 */
export const recurringPaymentFailed = (
  event: Charge,
  match: Match,
): RecurringPaymentFailedEvent => ({
  id: eventId(event.idemKey, 'failed'),
  name: 'recurring_payment_failed',
  occurredAt: event.occurredAt,
  correlationId: event.idemKey,
  externalUserId: match.externalUserId,
  aggregateId: match.prolongOf ?? match.renewalOf ?? event.externalRef,
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
    method: match.method,
    period: match.period,
    renewal: match.renewal ?? null,
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
    // A bind reconciles a legacy/unknown payment; no scheduled next charge is known.
    nextPaymentDate: null,
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

/** Quarantine an unmatched charge (FR-009): the operator binds or refunds it. */
const quarantine = (deps: HandleDeps, event: Charge, incomingId: string) =>
  Effect.gen(function* () {
    const quarantineId = yield* deps.repo.upsertQuarantine(incomingId);
    yield* deps.repo.setMatchResult(incomingId, 'quarantined');
    yield* deps.publish(quarantined(event, quarantineId, incomingId));
  });

/** Why each refusal is a refund candidate, as the watchdog's marker line reads it. */
const REFUSAL_REASON: Record<RefusedCharge['refused'], string> = {
  already_applied: 'charge: session already settled',
  intro_on_live: 'checkout: intro-priced payment on a live subscription',
};

/** The applier refused the charge and wrote nothing: quarantine it, loudly. */
const quarantineRefused = (
  deps: HandleDeps,
  event: Charge,
  incomingId: string,
  refusal: RefusedCharge,
) =>
  Effect.gen(function* () {
    yield* settlementAnomaly(REFUSAL_REASON[refusal.refused], event);
    yield* quarantine(deps, event, incomingId);
  });

/** Record a matched, succeeded charge: apply, fix the payment, emit created?/succeeded. */
const recordMatchedSuccess = (
  deps: HandleDeps,
  event: Charge,
  match: Match,
  incomingId: string,
) =>
  Effect.gen(function* () {
    const applied = yield* deps.applier(event, match);
    if ('refused' in applied) {
      return yield* quarantineRefused(deps, event, incomingId, applied);
    }
    yield* deps.repo.insertPayment({
      incomingEventId: incomingId,
      paymentId: applied.subscriptionId,
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      source: event.source,
      occurredAt: event.occurredAt,
    });
    if (applied.created) {
      yield* deps.publish(paymentCreated(event, match, applied.subscriptionId));
    }
    if (applied.reactivated === true) {
      // A paid prolongation un-cancels (AC 19): the same event an operator un-cancel
      // emits, its id keyed on the charge time so a retry dedupes.
      yield* deps.publish(
        paymentReactivated(
          {
            paymentId: applied.subscriptionId,
            externalUserId: match.externalUserId,
            at: event.occurredAt.getTime(),
          },
          event.occurredAt,
        ),
      );
    }
    yield* deps.publish(paymentSucceeded(event, match, applied));
    yield* deps.repo.setMatchResult(incomingId, 'matched');
  });

/**
 * A card-change callback (docs/23). The applier has updated the stored token (and,
 * for an arrears change, advanced the existing payment — never create-or-extend, so the
 * one-active-payment invariant holds). A charge that moved money records the fixation
 * and emits `recurring_payment_succeeded` like any renewal; every success emits
 * `card_change_succeeded`. A decline emits `card_change_failed` and leaves the payment
 * untouched.
 */
const recordCardChange = (
  deps: HandleDeps,
  event: Charge,
  match: Match,
  incomingId: string,
) =>
  Effect.gen(function* () {
    if (event.status !== 'succeeded') {
      yield* deps.publish(cardChangeFailed(event, match));
      yield* deps.repo.setMatchResult(incomingId, 'matched');
      return;
    }
    const applied = yield* deps.applier(event, match);
    if ('refused' in applied) {
      return yield* quarantineRefused(deps, event, incomingId, applied);
    }
    if (match.amountCharged === true) {
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
        recurringPaymentSucceeded(
          event,
          match,
          applied.subscriptionId,
          applied.nextPaymentDate,
        ),
      );
    }
    yield* deps.publish(cardChangeSucceeded(event, match));
    yield* deps.repo.setMatchResult(incomingId, 'matched');
  });

/**
 * Settle one incoming charge, atomically: everything after the raw upsert runs in ONE
 * transaction (claim, subscription write, fixation, events, match result), with the
 * outbox publish and the queue enqueue as savepoints on the same client. Its first
 * statement locks the charge's `matchResult`; a charge already `'matched'` (a queue
 * retry or reaper requeue of a settled attempt) does nothing, and a concurrent attempt
 * waits here for the first to commit. `'matched'` is the LAST write of every settled
 * path, so it is never seen without the rest. A `'quarantined'` charge re-runs; its
 * writes are idempotent.
 */
const process = (deps: HandleDeps, event: Charge) =>
  Effect.gen(function* () {
    // Outside the transaction, so the raw receipt survives a failed settlement.
    const incomingId = yield* deps.repo.upsertIncomingCharge(event);
    yield* deps.repo.transaction(
      Effect.gen(function* () {
        if ((yield* deps.repo.lockMatchResult(incomingId)) === 'matched') {
          return;
        }
        const match = yield* deps.matcher(event);
        if (!match.matched) {
          return yield* quarantine(deps, event, incomingId);
        }
        if (match.kind === 'card_change') {
          return yield* recordCardChange(deps, event, match, incomingId);
        }
        if (event.status !== 'succeeded') {
          // Matched a known checkout session but the charge did not succeed. No retry
          // ladder — the customer re-initiates checkout; the session stays open for
          // another attempt. Recurring failures never reach the pipeline (the scheduler
          // emits them), so a matched non-success is a checkout one: a failed
          // prolongation when the contact holds a live sub or it is a manual renewal
          // (AC 25), else a declined first payment (FR-003).
          yield* deps.publish(
            match.prolongOf != null || match.origin === 'manual_renewal'
              ? recurringPaymentFailed(event, match)
              : initialPaymentFailed(event, match),
          );
          yield* deps.repo.setMatchResult(incomingId, 'matched');
          return;
        }
        yield* recordMatchedSuccess(deps, event, match, incomingId);
      }),
    );
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
