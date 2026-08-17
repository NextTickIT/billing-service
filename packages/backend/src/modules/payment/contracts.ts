import { Schema } from 'effect';

export {
  PAYMENT_CANCEL,
  PAYMENT_REACTIVATE,
  PAYMENT_DEFER,
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

/** payment_lapse payload: a cancel-pending payment reached its due date. */
export const LapseNotify = Schema.Struct({
  paymentId: Schema.String,
  externalUserId: Schema.String,
});

export type LapseNotify = Schema.Schema.Type<typeof LapseNotify>;

/** POST /api/payment/:id/cancel body: an optional operator reason. */
export const CancelRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export type CancelRequest = Schema.Schema.Type<typeof CancelRequest>;
