import type {
  ChargeRetryFailedEvent,
  PaymentCancelledEvent,
  Payment,
  PaymentManualRequiredEvent,
  UpcomingChargeEvent,
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

/**
 * Keyed on the due date of the attempt that failed, not the attempt number alone: the
 * ladder resets to attempt 1 whenever a payment recovers and later fails again, so
 * `_retry_1` collided across ladders and every retry of a second ladder was dropped.
 * This is the same anchor the provider `orderReference` uses, so the event key and the
 * charge it describes identify the same attempt.
 */
export const chargeRetryFailed = (
  sub: Payment,
  failure: RetryFailure,
  now: Date,
): ChargeRetryFailedEvent => ({
  id: `evt_sub_${sub.id}_retry_${sub.nextPaymentDate.getTime().toString()}_${failure.attempt.toString()}`,
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

/**
 * Keyed on the attempt the ladder gave up at. A constant id meant a payment that failed,
 * was resubscribed, and failed again reported only the first failure.
 */
export const renewalFailed = (
  sub: Payment,
  reason: string,
  now: Date,
): RenewalFailedEvent => ({
  id: `evt_sub_${sub.id}_renewal_failed_${sub.nextPaymentDate.getTime().toString()}`,
  name: 'renewal_failed',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: { reason },
});

/**
 * The contact cancelled/quarantined on the SendPulse side, detected by the
 * scheduler's pre-charge tag check (docs/23): cancel on our side and never charge.
 * Same deterministic id as the operator cancel so the two dedupe. Recorded for
 * audit; intentionally NOT mapped to a SendPulse flow (no echo back to a user who
 * already cancelled).
 */
export const sinkCancelled = (
  sub: Payment,
  reason: string,
  now: Date,
  cancelRequestedAt: Date,
): PaymentCancelledEvent => ({
  id: `evt_sub_${sub.id}_cancelled_${cancelRequestedAt.toISOString()}`,
  name: 'payment_cancelled',
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
  attempt: number,
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
    attempt,
  },
});

/**
 * Advance notice of a scheduled charge. The id pins the payment, the exact due date and
 * the offset, so the scheduler can re-run this sweep every tick and the outbox's
 * `ON CONFLICT (id) DO NOTHING` makes it fire exactly once per (payment, date, offset).
 * If the due date later moves, the id changes and a fresh notice correctly goes out.
 */
export const upcomingCharge = (
  sub: Payment,
  noticeDays: number,
  now: Date,
): UpcomingChargeEvent => ({
  id: `evt_sub_${sub.id}_upcoming_${sub.nextPaymentDate.getTime().toString()}_${noticeDays.toString()}`,
  name: 'upcoming_charge',
  occurredAt: now,
  correlationId: sub.id,
  externalUserId: sub.externalUserId,
  aggregateId: sub.id,
  payload: {
    paymentId: sub.id,
    amount: sub.amount,
    currency: sub.currency,
    method: sub.method,
    period: sub.period,
    chargeDate: sub.nextPaymentDate.toISOString(),
    noticeDays,
  },
});
