import { Schema } from 'effect';

/**
 * Subscription cancellation contracts (FR-012). The support endpoint stays thin —
 * it marks the subscription cancelled and enqueues a `subscription_cancel`, and the
 * worker turns that into the outgoing `subscription_cancelled` event (the outbox
 * lives in the worker runtime).
 */
export const SUBSCRIPTION_CANCEL = 'subscription_cancel';

export const CancelNotify = Schema.Struct({
  subscriptionId: Schema.String,
  externalUserId: Schema.String,
  reason: Schema.String,
});

export type CancelNotify = Schema.Schema.Type<typeof CancelNotify>;

/** POST /api/support/subscriptions/:id/cancel body: an optional operator reason. */
export const CancelRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export type CancelRequest = Schema.Schema.Type<typeof CancelRequest>;
