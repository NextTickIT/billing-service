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

/**
 * The result of matching an incoming event to a gateway subscription. A match
 * carries everything the outgoing `payment_succeeded` needs (docs/07) that the
 * event itself doesn't (period, method). No match → the event is quarantined.
 */
export type MatchResult =
  | {
      readonly matched: true;
      readonly subscriptionId: string;
      readonly externalUserId: string;
      readonly period: string;
      readonly method: number;
    }
  | { readonly matched: false };

/**
 * Matching port — the seam a real matcher (checkout session / subscription
 * lookup, M5/M6) plugs into without touching the pipeline (AC8). The MVP default
 * matches nothing, so every real payment quarantines until a matcher is wired.
 */
export interface PaymentMatcherService {
  readonly match: (event: IncomingPaymentEvent) => Effect.Effect<MatchResult>;
}

export class PaymentMatcher extends Context.Tag('PaymentMatcher')<
  PaymentMatcher,
  PaymentMatcherService
>() {}

export const NoMatchLive = Layer.succeed(PaymentMatcher, {
  match: () => Effect.succeed({ matched: false }),
});
