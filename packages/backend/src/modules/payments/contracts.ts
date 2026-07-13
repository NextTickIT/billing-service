import type { SqlError } from '@effect/sql';
import { CurrencySchema } from '@billing-service/shared';
import { Context, Effect, Layer, Schema } from 'effect';

/**
 * Payment-pipeline contracts (FR-007). Every source normalizes its event into an
 * `IncomingPaymentEvent` and hands it to the pipeline; the pipeline is the single
 * place that matches, records, quarantines, and emits — sources carry no domain
 * logic ([15] D4).
 */

/** Queue message type for a normalized incoming payment awaiting processing. */
export const PAYMENT_EVENT_RECEIVED = 'payment_event_received';

/** Queue message type for an operator-bound quarantine, reprocessed by the worker. */
export const PAYMENT_REBIND = 'payment_rebind';

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

/** Normalized status of an incoming payment, provider-agnostic. */
export const PAYMENT_EVENT_STATUSES = [
  'succeeded',
  'failed',
  'refunded',
  'pending',
  'unknown',
] as const;

export const PaymentEventStatus = Schema.Literal(...PAYMENT_EVENT_STATUSES);

export type PaymentEventStatus = Schema.Schema.Type<typeof PaymentEventStatus>;

/**
 * A normalized incoming payment. `idemKey` is the source's dedup key (e.g.
 * `w4p:{orderReference}|{type}|{createdDate}`); `externalRef` is what matching
 * keys on (the provider orderReference). This shape is also the `payment_event_
 * received` message payload, decoded by the handler.
 */
export const IncomingPaymentEvent = Schema.Struct({
  source: Schema.String,
  idemKey: Schema.String,
  externalRef: Schema.String,
  externalUserId: Schema.NullOr(Schema.String),
  amount: Schema.Int,
  currency: CurrencySchema,
  status: PaymentEventStatus,
  occurredAt: Schema.Date,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export type IncomingPaymentEvent = Schema.Schema.Type<
  typeof IncomingPaymentEvent
>;

/** How a matched payment relates to a subscription: a first checkout payment
 * (create-or-extend) or a charge against one that already exists (M6). */
export type MatchKind = 'checkout' | 'recurring';

/**
 * The result of matching an incoming event to a gateway subscription. A match
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
 * Matching port — the seam a real matcher (checkout session / subscription
 * lookup, M5/M6) plugs into without touching the pipeline (AC8). The MVP default
 * matches nothing, so every real payment quarantines until a matcher is wired.
 */
export interface PaymentMatcherService {
  readonly match: (
    event: IncomingPaymentEvent,
  ) => Effect.Effect<MatchResult, SqlError.SqlError>;
}

export class PaymentMatcher extends Context.Tag('PaymentMatcher')<
  PaymentMatcher,
  PaymentMatcherService
>() {}

export const NoMatchLive = Layer.succeed(PaymentMatcher, {
  match: () => Effect.succeed({ matched: false }),
});

/** The subscription a matched payment resolved to, and whether it was just born. */
export interface AppliedPayment {
  readonly subscriptionId: string;
  readonly created: boolean;
}

/**
 * Applier port — the domain follow-up for a matched payment (FR-003): create or
 * extend the subscription and store the token. Kept out of the pipeline so the
 * pipeline stays generic (AC8). The default refuses: it is only reachable if a
 * matcher matched without an applier wired, which is a misconfiguration.
 */
export interface PaymentApplierService {
  readonly apply: (
    event: IncomingPaymentEvent,
    match: Match,
  ) => Effect.Effect<AppliedPayment, SqlError.SqlError>;
}

export class PaymentApplier extends Context.Tag('PaymentApplier')<
  PaymentApplier,
  PaymentApplierService
>() {}

export const NoApplyLive = Layer.succeed(PaymentApplier, {
  apply: () =>
    Effect.dieMessage('no PaymentApplier configured for a matched payment'),
});
