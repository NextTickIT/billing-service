import { Effect } from 'effect';

import type {
  AppliedPayment,
  PaymentApplier,
} from '@/modules/payments/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { SubscriptionRepo } from '@/modules/subscription/data-access.js';
import { createOrExtend } from '@/modules/subscription/domain.js';

/** The recToken the provider returns on a card checkout, if any. */
const recToken = (payload: Record<string, unknown>): string | null =>
  typeof payload['recToken'] === 'string' && payload['recToken'].length > 0
    ? payload['recToken']
    : null;

/**
 * Checkout applier (FR-003): a matched checkout payment creates or extends the
 * user's subscription (storing the card token) and marks the session completed.
 * A `recurring` match already has its subscription — the scheduler advances it
 * (M6) — so the applier just reports it.
 */
export const makeCheckoutApplier =
  (subscriptions: SubscriptionRepo, checkout: CheckoutRepo): PaymentApplier =>
  (event, match) => {
    if (match.kind === 'recurring' && match.subscriptionId !== null) {
      const applied: AppliedPayment = {
        subscriptionId: match.subscriptionId,
        created: false,
      };
      return Effect.succeed(applied);
    }
    return createOrExtend(subscriptions)({
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      method: match.method,
      period: match.period,
      recurringTokenRef: recToken(event.payload),
      paidAt: event.occurredAt,
    }).pipe(Effect.tap(() => checkout.markCompleted(event.externalRef)));
  };
