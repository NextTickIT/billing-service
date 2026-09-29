import { Schema } from 'effect';

export {
  PAYMENT_CANCEL,
  PAYMENT_REACTIVATE,
  PAYMENT_DEFER,
  PAYMENT_METHOD_CHANGE,
  PAYMENT_LAPSE,
} from '@billing-service/shared';

/**
 * Payment lifecycle notify contracts (docs/23). A lifecycle route (cancel,
 * reactivate, defer, and the scheduler's due-date lapse) persists state and
 * enqueues one of these messages; the matching worker handler turns it into the
 * outgoing domain event (the outbox lives only in the worker runtime). The
 * message types live in shared.
 */

export const CancelNotify = Schema.Struct({
  subscriptionId: Schema.String,
  externalUserId: Schema.String,
  reason: Schema.String,
  /**
   * When THIS cancellation was stamped, ISO-8601. The occurrence discriminator: the
   * queue idemKey and the event id both derive from it, so a cancel → reactivate →
   * cancel yields distinct keys while a redelivery of one cancellation does not.
   * Declared here because `Schema.Struct` drops undeclared keys silently — an
   * unadded field would vanish between enqueue and handler with no error.
   */
  cancelRequestedAt: Schema.String,
});

export type CancelNotify = Schema.Schema.Type<typeof CancelNotify>;

/** payment_reactivate payload: the payment reactivated inside the grace window. */
export const ReactivateNotify = Schema.Struct({
  paymentId: Schema.String,
  externalUserId: Schema.String,
  at: Schema.Number,
});

export type ReactivateNotify = Schema.Schema.Type<typeof ReactivateNotify>;

/** payment_defer payload: the new paid-through date + the granted day count. */
export const DeferNotify = Schema.Struct({
  paymentId: Schema.String,
  externalUserId: Schema.String,
  newPeriodEnd: Schema.String,
  days: Schema.Int,
  at: Schema.Number,
});

export type DeferNotify = Schema.Schema.Type<typeof DeferNotify>;

/** payment_method_change payload: the no-payment flip recorded the new method. */
export const MethodChangeNotify = Schema.Struct({
  paymentId: Schema.String,
  externalUserId: Schema.String,
  method: Schema.Int,
  at: Schema.Number,
});

export type MethodChangeNotify = Schema.Schema.Type<typeof MethodChangeNotify>;

/** payment_lapse payload: a cancel-pending payment reached its due date. */
export const LapseNotify = Schema.Struct({
  paymentId: Schema.String,
  externalUserId: Schema.String,
  /**
   * The `cancelRequestedAt` this lapse belongs to, ISO-8601 — NOT the tick's clock.
   * The scheduler re-offers the row on every tick until `markCancelledLapsed` commits,
   * so a time-of-tick key would enqueue one message per tick; keyed on the cancellation
   * it lapses, every tick in that window produces the same key and collapses to one.
   */
  cancelRequestedAt: Schema.String,
});

export type LapseNotify = Schema.Schema.Type<typeof LapseNotify>;

/** POST /api/payment/:id/cancel body: an optional operator reason. */
export const CancelRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export type CancelRequest = Schema.Schema.Type<typeof CancelRequest>;
