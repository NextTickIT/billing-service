import { PaymentMethod } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { PaymentMatcher } from '@/modules/payments/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';

/**
 * Checkout matcher: a succeeded incoming event whose `externalRef` is a known
 * checkout session id resolves to a `checkout` match (create-or-extend). Only
 * succeeded events match — a decline for a known session, and any event for an
 * unknown ref, fall through to quarantine (FR-009). Poller/legacy events never
 * match here (no session), so they quarantine until the recurring matcher (M6).
 */
export const makeCheckoutMatcher =
  (repo: CheckoutRepo): PaymentMatcher =>
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
