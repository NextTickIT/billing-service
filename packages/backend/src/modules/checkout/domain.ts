import type { SqlError } from '@effect/sql';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type {
  AppliedCharge,
  ChargeApplier,
  ChargeMatcher,
  Match,
} from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { createOrExtend } from '@/modules/payment/domain.js';
import { addPeriod } from '@/modules/payment/period.js';

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
      // A card-change session is handled by its own matcher/applier — never as a
      // first checkout (which would create-or-extend a second payment).
      if (session.kind !== CheckoutSessionKind.Checkout) {
        return { matched: false };
      }
      // A session is completed on the FIRST successful charge. A second success (crypto
      // double-pay: two paid orders for one session) or a late decline arriving after
      // completion must NOT re-credit or emit a spurious failure — fall through to
      // quarantine so the operator sees it (a refund candidate), never book it (docs/26).
      if (session.status === CheckoutSessionStatus.Completed) {
        return { matched: false };
      }
      return {
        matched: true,
        kind: 'checkout',
        subscriptionId: null,
        externalUserId: session.externalUserId,
        period: session.period,
        method: session.method ?? PaymentMethod.Card,
      };
    });

/**
 * Card-change matcher (docs/23): a callback whose session is a `card_change`
 * resolves to that session's target payment. Runs BEFORE the checkout matcher.
 * `owed` distinguishes a priced Purchase (past_due/renewal_failed) from a 0-amount
 * verify. Both success and failure match here so the pipeline can emit the outcome.
 */
export const makeCardChangeMatcher =
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
      if (
        session.kind !== CheckoutSessionKind.CardChange ||
        session.paymentId === null
      ) {
        return { matched: false };
      }
      return {
        matched: true,
        kind: 'card_change',
        subscriptionId: session.paymentId,
        externalUserId: session.externalUserId,
        period: session.period,
        method: session.method ?? PaymentMethod.Card,
        owed: session.amount > 0,
      };
    });

/** The recToken the provider returns on a card checkout, if any. */
const recToken = (payload: Record<string, unknown>): string | null =>
  typeof payload['recToken'] === 'string' && payload['recToken'].length > 0
    ? payload['recToken']
    : null;

/** A payment that still owes for the current period (a card change collects it). */
const owesMoney = (status: PaymentStatus): boolean =>
  status === PaymentStatus.PastDue || status === PaymentStatus.RenewalFailed;

/**
 * Card-change applier (docs/23): rewrite the stored token on the target payment and,
 * for an owed change, advance the SAME payment (never create-or-extend, so the
 * one-active-payment invariant holds) — `advanceAfterSuccess` also resets the retry
 * ladder and sets `active`, reviving a past_due/renewal_failed payment in place. The
 * new period anchors on the existing `currentPeriodEnd` (drift-free).
 */
const applyCardChange =
  (payments: PaymentRepo, checkout: CheckoutRepo) =>
  (
    event: Parameters<ChargeApplier>[0],
    paymentId: string,
    owed: boolean,
  ): Effect.Effect<AppliedCharge, SqlError.SqlError> =>
    Effect.gen(function* () {
      const token = recToken(event.payload);
      if (token !== null) {
        yield* payments.updateToken(paymentId, token);
      }
      if (owed) {
        const found = yield* payments.findById(paymentId);
        // Guard the advance on the payment still OWING (past_due/renewal_failed):
        // `advanceAfterSuccess` moves the anchor unconditionally, so a reaper
        // redelivery would advance a second period. A redelivered callback finds the
        // payment already `active` and skips — the anchor moves exactly once. The
        // token update, the fixation, and the emitted events are id-idempotent.
        if (Option.isSome(found) && owesMoney(found.value.status)) {
          const p = found.value;
          const currentPeriodEnd = addPeriod(p.currentPeriodEnd, p.period);
          yield* payments.advanceAfterSuccess(paymentId, {
            currentPeriodStart: p.currentPeriodEnd,
            currentPeriodEnd,
            nextPaymentDate: currentPeriodEnd,
          });
        }
      }
      yield* checkout.markCompleted(event.externalRef);
      return { subscriptionId: paymentId, created: false };
    });

/**
 * Checkout applier (FR-003): a matched checkout payment creates or extends the
 * user's payment (storing the card token) and marks the session completed. A
 * `recurring` match already has its payment — the scheduler advances it (M6) — so the
 * applier just reports it. A `card_change` match re-tokenizes an existing payment.
 */
export const makeCheckoutApplier =
  (payments: PaymentRepo, checkout: CheckoutRepo): ChargeApplier =>
  (event, match: Match) => {
    if (match.kind === 'card_change' && match.subscriptionId !== null) {
      return applyCardChange(payments, checkout)(
        event,
        match.subscriptionId,
        match.owed === true,
      );
    }
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
