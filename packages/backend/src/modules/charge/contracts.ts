import type { SqlError } from '@effect/sql';
import {
  ChargeStatus,
  CHARGE_STATUSES,
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
 * A normalized incoming charge. `idemKey` is the source's dedup key (e.g.
 * `w4p:{orderReference}|{type}|{createdDate}`); `externalRef` is what matching
 * keys on (the provider orderReference). This shape is also the `payment_event_
 * received` message payload, decoded by the handler.
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
});

export type Charge = Schema.Schema.Type<typeof Charge>;

/** How a matched charge relates to a subscription: a first checkout payment
 * (create-or-extend) or a charge against one that already exists (M6). */
export type MatchKind = 'checkout' | 'recurring';

/**
 * The result of matching an incoming charge to a gateway subscription. A match
 * carries what the outgoing events need (docs/07) that the event itself doesn't
 * (period, method). `subscriptionId` is null for a checkout first payment — the
 * subscription is created while applying it. No match → the event is quarantined.
 */
export type MatchResult =
  | {
      readonly matched: true;
      readonly kind: MatchKind;
      readonly subscriptionId: string | null;
      readonly externalUserId: string;
      readonly period: string;
      readonly method: number;
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
export interface AppliedCharge {
  readonly subscriptionId: string;
  readonly created: boolean;
}

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
