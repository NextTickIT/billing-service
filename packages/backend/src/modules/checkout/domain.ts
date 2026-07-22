import { PaymentMethod } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type {
  AppliedCharge,
  ChargeApplier,
  ChargeMatcher,
} from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { createOrExtend } from '@/modules/payment/domain.js';

/** The public checkout page URL for a session id (served by the frontend SPA). */
export const checkoutPath = (sessionId: string): string =>
  `https://bill.nexttick.it/checkout/${sessionId}`;

/**
 * Checkout matcher: an incoming event whose `externalRef` is a known checkout
 * session id resolves to a `checkout` match. A succeeded event is create-or-extend;
 * a declined one is a first-payment failure (the pipeline emits
 * `initial_payment_failed`, FR-003) — both are OUR session, not an unknown payment.
 * Intermediate/other statuses (pending, refunded) still fall through to quarantine,
 * as do events for an unknown ref. Poller/legacy events never match here (no session).
 */
export const makeCheckoutMatcher =
  (repo: CheckoutRepo): ChargeMatcher =>
  (event) =>
    Effect.gen(function* () {
      if (event.status !== 'succeeded' && event.status !== 'failed') {
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
  (payments: PaymentRepo, checkout: CheckoutRepo): ChargeApplier =>
  (event, match) => {
    if (match.kind === 'recurring' && match.subscriptionId !== null) {
      const applied: AppliedCharge = {
        subscriptionId: match.subscriptionId,
        created: false,
      };
      return Effect.succeed(applied);
    }
    return createOrExtend(payments)({
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      method: match.method,
      period: match.period,
      recurringTokenRef: recToken(event.payload),
      paidAt: event.occurredAt,
    }).pipe(Effect.tap(() => checkout.markCompleted(event.externalRef)));
  };
