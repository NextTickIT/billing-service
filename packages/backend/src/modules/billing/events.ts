import type { DomainEvent, Subscription } from '@billing-service/shared';

import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';

/**
 * Outgoing events for the recurring billing cycle (docs/07, §5.3). A successful
 * charge is fed back through the pipeline as an incoming event so payment fixation
 * and `payment_succeeded` stay single-path (and the poller re-seeing the same row
 * dedupes on the shared idem key). Failures are the scheduler's own events.
 */

/** A successful charge, shaped as a standard incoming event for the pipeline. */
export const chargeIncomingEvent = (
  sub: Subscription,
  orderReference: string,
  response: W4pChargeResponse,
  now: Date,
): IncomingPaymentEvent => {
  const createdDate = String(
    response.createdDate ?? Math.floor(now.getTime() / 1000),
  );
  return {
    source: 'wayforpay_charge',
    // Same scheme the poller derives, so a later journal read dedupes (FR-006).
    idemKey: `w4p:${orderReference}|CHARGE|${createdDate}`,
    externalRef: orderReference,
    externalUserId: sub.externalUserId,
    amount: sub.amount,
    currency: sub.currency,
    status: 'succeeded',
    occurredAt: now,
    payload: { ...response },
  };
};

export interface RetryFailure {
  readonly attempt: number;
  readonly nextRetryDate: Date;
  readonly reason: string;
}

export const chargeRetryFailed = (
  sub: Subscription,
  failure: RetryFailure,
  now: Date,
): DomainEvent => ({
  id: `evt_sub_${sub.id}_retry_${failure.attempt.toString()}`,
  name: 'charge_retry_failed',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: {
    attempt: failure.attempt,
    nextRetryDate: failure.nextRetryDate.toISOString(),
    reason: failure.reason,
  },
});

export const renewalFailed = (
  sub: Subscription,
  reason: string,
  now: Date,
): DomainEvent => ({
  id: `evt_sub_${sub.id}_renewal_failed`,
  name: 'renewal_failed',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: { reason },
});
