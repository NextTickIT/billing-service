import type { SqlError } from '@effect/sql';
import {
  ChargeStatus,
  CHARGE_STATUSES,
  type CheckoutOrigin,
  type CheckoutRenewal,
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@billing-service/shared';
import { Effect, Schema } from 'effect';

/**
 * Charge-pipeline contracts (FR-007). Every source normalizes its event into a
 * `Charge` and hands it to the pipeline; the pipeline is the single place that
 * matches, records, quarantines, and emits — sources carry no domain logic ([15]
 * D4). The public charge status vocabulary and the queue message types live in
 * shared; they are re-exported here for the pipeline's callers.
 */
export {
  ChargeStatus,
  CHARGE_STATUSES,
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
};

/**
 * Operator bind decision (FR-009): reprocess a quarantined event AS IF matched to
 * the given user (and optionally a subscription). Carried on a `payment_rebind`
 * message so the worker records the payment and emits the outgoing event, exactly
 * like a normal match — the operator's action just supplies the match.
 */
export const RebindPayload = Schema.Struct({
  incomingEventId: Schema.String,
  quarantineId: Schema.String,
  externalUserId: Schema.String,
  subscriptionId: Schema.NullOr(Schema.String),
  period: Schema.String,
  method: Schema.Int,
});

export type RebindPayload = Schema.Schema.Type<typeof RebindPayload>;

/**
 * What a source already credited when it settled the charge before handing it over: the
 * period and method it charged, the window, the next charge date and the declaration the
 * payment carried at that moment.
 * Only the scheduler settles first (it advances the payment, then ingests its own charge),
 * and the message can wait in the queue while the row moves on — a defer, an operator
 * edit, the next renewal. The success event reports this snapshot, not the row as it is
 * when the message is processed.
 */
export const Settlement = Schema.Struct({
  period: Schema.String,
  method: Schema.Int,
  periodStart: Schema.Date,
  periodEnd: Schema.Date,
  nextPaymentDate: Schema.Date,
  metadata: Schema.NullOr(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

/**
 * A normalized incoming charge. `idemKey` is the source's dedup key (e.g.
 * `w4p:{orderReference}|{type}|{createdDate}`); `externalRef` is what matching
 * keys on (the provider orderReference). This shape is also the `payment_event_
 * received` message payload, decoded by the handler. `settlement` is set only by a
 * source that settled first (see `Settlement`); a message without it — every other
 * source, and one enqueued before the field existed — falls back to the payment row.
 */
export const Charge = Schema.Struct({
  source: Schema.String,
  idemKey: Schema.String,
  externalRef: Schema.String,
  externalUserId: Schema.NullOr(Schema.String),
  amount: Schema.Int,
  currency: Schema.Int,
  status: ChargeStatus,
  occurredAt: Schema.Date,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  settlement: Schema.optional(Settlement),
});

export type Charge = Schema.Schema.Type<typeof Charge>;

/**
 * The log line the watchdog alerts on (`SETTLEMENT_ANOMALY`): a charge that took money
 * but could not settle, a refund candidate. One shape for every call site; `idemKey` is
 * the charge's identity (the `charges` row is unique on it).
 */
export const settlementAnomaly = (reason: string, event: Charge) =>
  Effect.logError(`SETTLEMENT_ANOMALY ${reason}`).pipe(
    Effect.annotateLogs({
      idemKey: event.idemKey,
      externalRef: event.externalRef,
      source: event.source,
    }),
  );

/** How a matched charge relates to a gateway payment: a first checkout payment
 * (create-or-extend), a charge against one that already exists (M6), or a
 * SendPulse-initiated card change that re-tokenizes an existing payment (docs/23). */
export type MatchKind = 'checkout' | 'recurring' | 'card_change';

/**
 * The result of matching an incoming charge to a gateway payment. A match carries
 * what the outgoing events need (docs/07) that the event itself doesn't (period,
 * method). `subscriptionId` is null for a checkout first payment — the payment is
 * created while applying it; for `card_change` it is the target payment id. `recurring`
 * is only consumed on the `checkout` create path (false → a one-time payment); it
 * defaults to true when absent, since a `recurring`/`card_change` match acts on an
 * already-recurring payment. `promoBonus` is a one-time bonus period (ISO-8601 duration) a
 * `checkout` session may carry: applied once on the create path to push the paid-through
 * anchor further; absent on `recurring`/`card_change` (a renewal never re-earns it). No
 * match → quarantine.
 */
export type MatchResult =
  | {
      readonly matched: true;
      readonly kind: MatchKind;
      readonly subscriptionId: string | null;
      readonly externalUserId: string;
      readonly period: string;
      readonly method: number;
      /** `card_change` only: the charge moved money (> 0), so it is fixed and reported as
       * `recurring_payment_succeeded`. A 0-amount verify moved none. */
      readonly amountCharged?: boolean;
      /** `card_change` only: the session was minted to collect arrears, so it credits its
       * own period. Decided at mint time (`origin`), never inferred at settlement. */
      readonly arrears?: boolean;
      readonly recurring?: boolean;
      readonly promoBonus?: string | null;
      /** The checkout session's renewal terms, when they differ from the first charge. */
      readonly renewal?: CheckoutRenewal | null;
      /** Who minted the session; null on sessions from before the column existed. Selects
       * the event name for a manual renewal (AC 25), never the row the applier writes. */
      readonly origin?: CheckoutOrigin | null;
      /** The subscription a `prolong`/`manual_renewal` session renews (the session column).
       * Attribution only: the decline `aggregateId` after that sub has died. */
      readonly renewalOf?: string | null;
      /** A declined recurring checkout whose contact holds a live sub: that sub's id. An
       * unlocked read that only selects the decline event's name and aggregate. */
      readonly prolongOf?: string | null;
      /** The session's own price, the terms a checkout stores (never the callback's). */
      readonly amount?: number;
      readonly currency?: number;
      /** Opaque caller declaration to stamp on the payment and echo on its events. A
       * `checkout` match carries the session's; a `recurring` match carries the payment's
       * own (the last one declared), so a renewal reports intent rather than dropping it. */
      readonly metadata?: Record<string, unknown> | null | undefined;
    }
  | { readonly matched: false };

export type Match = Extract<MatchResult, { readonly matched: true }>;

/**
 * A matcher resolves an incoming charge to a subscription match, or to no match
 * (→ quarantine). It is a plain function the pipeline calls; the concrete matchers
 * (checkout session, recurring charge) are composed in the composition root, so a
 * new one plugs in without touching the pipeline (AC8).
 */
export type ChargeMatcher = (
  event: Charge,
) => Effect.Effect<MatchResult, SqlError.SqlError>;

/** Try each matcher in order; the first match wins (checkout, then recurring). */
export const makeCompositeMatcher =
  (matchers: readonly ChargeMatcher[]): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      for (const matcher of matchers) {
        const result = yield* matcher(event);
        if (result.matched) {
          return result;
        }
      }
      return { matched: false };
    });

/** The subscription a matched charge resolved to, and whether it was just born. */
export interface SettledCharge {
  readonly subscriptionId: string;
  readonly created: boolean;
  /** The charge stacked onto the contact's live recurring sub (a prolongation). */
  readonly prolonged: boolean;
  /** The prolongation cleared a pending cancel (→ `payment_reactivated`). */
  readonly reactivated?: boolean;
  /** The payment's next scheduled charge date after applying this charge, or null when
   * there is none (a one-time purchase, or a reconciliation with no known schedule). */
  readonly nextPaymentDate: Date | null;
  /** The window this charge actually bought — what the succeeded event reports as the
   * prolongation. Null where the applier establishes no window (a card-change verify). */
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /** The declaration the payment carries AFTER this charge: the one just supplied, or the
   * stored one a renewal left standing. Null when none was ever declared. */
  readonly metadata: Record<string, unknown> | null;
}

/**
 * What a succeeded-payment event reports beyond the charge itself: the schedule and the
 * window the money bought, plus the caller's declaration. Grouped so adding a fact to the
 * success contract touches one type rather than four builder signatures.
 */
export interface Prolongation {
  readonly nextPaymentDate: Date | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly metadata: Record<string, unknown> | null;
}

/**
 * A matched charge the applier refused to settle, having written nothing: the pipeline
 * quarantines it as a refund candidate and logs `SETTLEMENT_ANOMALY`.
 * - `already_applied`: a different charge already settled this session.
 * - `intro_on_live`: an intro-priced checkout paid while the contact holds a live sub
 *   (Q8, enforced again at settlement); `subscriptionId` is that live sub.
 */
export interface RefusedCharge {
  readonly refused: 'already_applied' | 'intro_on_live';
  readonly subscriptionId: string | null;
}

export type AppliedCharge = SettledCharge | RefusedCharge;

/**
 * An applier is the domain follow-up for a matched charge (FR-003): create or
 * extend the subscription and store the token. A plain function the pipeline calls
 * after a match; a `recurring` match already has its subscription, so its applier
 * just reports it. Kept out of the pipeline so the pipeline stays generic (AC8).
 */
export type ChargeApplier = (
  event: Charge,
  match: Match,
) => Effect.Effect<AppliedCharge, SqlError.SqlError>;
