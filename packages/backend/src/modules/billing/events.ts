import type {
  ChargeRetryFailedEvent,
  Payment,
  PaymentManualRequiredEvent,
  RenewalFailedEvent,
} from '@billing-service/shared';

import type { Charge } from '@/modules/charge/contracts.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';

/**
 * Outgoing events for the recurring billing cycle (docs/07, §5.3). A successful
 * charge is fed back through the pipeline as an incoming event so payment fixation
 * and `recurring_payment_succeeded` stay single-path (and the poller re-seeing the
 * same row dedupes on the shared idem key). Failures are the scheduler's own events.
 */

/** A successful charge, shaped as a standard incoming event for the pipeline. */
export const chargeIncomingEvent = (
  sub: Payment,
  orderReference: string,
  response: W4pChargeResponse,
  now: Date,
): Charge => {
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
  sub: Payment,
  failure: RetryFailure,
  now: Date,
): ChargeRetryFailedEvent => ({
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
  sub: Payment,
  reason: string,
  now: Date,
): RenewalFailedEvent => ({
  id: `evt_sub_${sub.id}_renewal_failed`,
  name: 'renewal_failed',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: { reason },
});

/** The internal checkout link a manual-pay prompt points the user at, and how long it
 * stays live (docs/28). Built by the composition root (it owns the checkout repo + TTL). */
export interface ManualCheckout {
  readonly checkoutUrl: string;
  readonly windowExpiresAt: Date;
}

/**
 * A due recurring charge with no usable token (WhitePay crypto) → prompt the user to pay
 * again at our internal checkout (docs/28). The id keys on the due date so an at-least-once
 * redelivery of the same attempt dedupes; a later attempt (a new due date) is its own event.
 */
export const paymentManualRequired = (
  sub: Payment,
  checkout: ManualCheckout,
  now: Date,
): PaymentManualRequiredEvent => ({
  id: `evt_sub_${sub.id}_manual_${sub.nextPaymentDate.getTime().toString()}`,
  name: 'payment_manual_required',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: {
    amount: sub.amount,
    currency: sub.currency,
    method: sub.method,
    paymentId: sub.id,
    checkoutUrl: checkout.checkoutUrl,
    dueDate: sub.nextPaymentDate.toISOString(),
    windowExpiresAt: checkout.windowExpiresAt.toISOString(),
  },
});
