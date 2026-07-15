import { PaymentMethod } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type {
  AppliedCharge,
  ChargeApplier,
  ChargeMatcher,
} from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { SubscriptionRepo } from '@/modules/subscription/data-access.js';
import { createOrExtend } from '@/modules/subscription/domain.js';

/** The public checkout page path for a session id (the CRM prepends the host). */
export const checkoutPath = (sessionId: string): string =>
  `/checkout/${sessionId}`;

/**
 * Checkout matcher: a succeeded incoming event whose `externalRef` is a known
 * checkout session id resolves to a `checkout` match (create-or-extend). Only
 * succeeded events match — a decline for a known session, and any event for an
 * unknown ref, fall through to quarantine (FR-009). Poller/legacy events never match
 * here (no session), so they quarantine until the recurring matcher (M6).
 */
export const makeCheckoutMatcher =
  (repo: CheckoutRepo): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      if (event.status !== 'succeeded') {
        return { matched: false };
      }
      const found = yield* repo.findById(event.externalRef);
      if (Option.isNone(found)) {
        return { matched: false };
      }
      const session = found.value;
      return {
        matched: true,
        kind: 'checkout',
        subscriptionId: null,
        externalUserId: session.externalUserId,
        period: session.period,
        method: session.method ?? PaymentMethod.Card,
      };
    });

/** The recToken the provider returns on a card checkout, if any. */
const recToken = (payload: Record<string, unknown>): string | null =>
  typeof payload['recToken'] === 'string' && payload['recToken'].length > 0
    ? payload['recToken']
    : null;

/**
 * Checkout applier (FR-003): a matched checkout payment creates or extends the
 * user's subscription (storing the card token) and marks the session completed. A
 * `recurring` match already has its subscription — the scheduler advances it (M6) —
 * so the applier just reports it.
 */
export const makeCheckoutApplier =
  (subscriptions: SubscriptionRepo, checkout: CheckoutRepo): ChargeApplier =>
  (event, match) => {
    if (match.kind === 'recurring' && match.subscriptionId !== null) {
      const applied: AppliedCharge = {
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
