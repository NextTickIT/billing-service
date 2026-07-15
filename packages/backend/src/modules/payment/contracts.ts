import { Schema } from 'effect';

export { SUBSCRIPTION_CANCEL } from '@billing-service/shared';

/**
 * Payment cancellation contracts (FR-012). The support endpoint stays thin —
 * it marks the payment cancelled and enqueues a `subscription_cancel`, and the
 * worker turns that into the outgoing `payment_cancelled` event (the outbox
 * lives in the worker runtime). The message type lives in shared.
 */

export const CancelNotify = Schema.Struct({
  subscriptionId: Schema.String,
  externalUserId: Schema.String,
  reason: Schema.String,
});

export type CancelNotify = Schema.Schema.Type<typeof CancelNotify>;

/** POST /api/support/payments/:id/cancel body: an optional operator reason. */
export const CancelRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export type CancelRequest = Schema.Schema.Type<typeof CancelRequest>;
