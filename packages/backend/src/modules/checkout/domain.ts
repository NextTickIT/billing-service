import type { SqlError } from '@effect/sql';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
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

/** The public checkout page URL for a session id (served by the frontend SPA). `baseUrl`
 * is the environment's `checkoutBaseUrl` config (no trailing slash). */
export const checkoutPath = (baseUrl: string, sessionId: string): string =>
  `${baseUrl}/checkout/${sessionId}`;

/**
 * Build OUR internal checkout session for a token-less (crypto) renewal prompt (docs/28):
 * a normal RECURRING checkout for the payment's own terms, with the last-used method
 * preselected. Paying it runs through create-or-extend and extends THIS recurring payment
 * (keyed on the user); a card pay captures a token and graduates it back to autocharge.
 */
export const manualRenewalSession = (
  sub: Payment,
  sessionId: string,
  expiresAt: Date,
  idempotencyKey: string,
): NewCheckoutSession => ({
  id: sessionId,
  externalUserId: sub.externalUserId,
  amount: sub.amount,
  currency: sub.currency,
  period: sub.period,
  method: sub.method,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  // One session per renewal cycle: re-prompts on the retry ladder reuse the SAME link
  // (the unique idempotencyKey collapses re-inserts), so a user can never hold several
  // independently-payable links for one cycle and double-pay.
  idempotencyKey,
  expiresAt,
});

/**
 * A caller-supplied post-payment redirect must point at an allowed host (docs/30). An
 * empty allowlist accepts any host (dev/default); otherwise the URL's hostname must be
 * listed — this stops an open redirect off our own checkout domain. The URL already
 * passed the http(s) scheme filter, so an unparseable value here is malformed → rejected.
 */
export const redirectHostAllowed = (
  allowedHosts: readonly string[],
  url: string,
): boolean => {
  if (allowedHosts.length === 0) {
    return true;
  }
  try {
    return allowedHosts.includes(new URL(url).hostname);
  } catch (err) {
    if (err instanceof TypeError) {
      return false;
    }
    throw err;
  }
};

/** How a method change lands. `flip` mutates the payment server-side (no payment);
 * `checkout` issues a pay/verify session for `amount` in the target method. */
export type MethodChangePlan =
  | { readonly action: 'flip' }
  | { readonly action: 'checkout'; readonly amount: number };

/**
 * Decide how a method change takes effect (docs/method-change), previous-method agnostic:
 * an up-to-date subscription switching TO crypto flips server-side — crypto has no free
 * verify (WhitePay minimum), so we just drop the card token and record crypto, and the
 * next renewal becomes a manual crypto prompt. Every other case issues a checkout in the
 * target method: an owed subscription (past_due/renewal_failed) pays its arrears and
 * revives in place; an up-to-date one runs a 0-amount card verify when enabled, else a
 * minimal tokenizing charge (`cardChangeChargeMinor`). Mirrors the card-change amount rule.
 */
export const planMethodChange = (
  payment: Payment,
  targetMethod: number,
  cardVerifyEnabled: boolean,
  cardChangeChargeMinor: number,
): MethodChangePlan => {
  const owed =
    payment.status === PaymentStatus.PastDue ||
    payment.status === PaymentStatus.RenewalFailed;
  if (!owed && targetMethod === PaymentMethod.Crypto) {
    return { action: 'flip' };
  }
  const amount = owed
    ? payment.amount
    : cardVerifyEnabled
      ? 0
      : cardChangeChargeMinor;
  return { action: 'checkout', amount };
};

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
        recurring: session.recurring,
        // A one-time bonus period the session carried; applied once on the create path.
        promoBonus: session.promo?.additionalFreePeriod ?? null,
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
    targetMethod: number,
  ): Effect.Effect<AppliedCharge, SqlError.SqlError> =>
    Effect.gen(function* () {
      // Persist the destination method (docs/method-change), previous-method agnostic:
      // → Crypto drops the card token (WhitePay carries none) so the next renewal is a
      // manual crypto prompt (scheduler branches on token presence); → Card stores the new
      // token the provider returned. `setMethod` keeps the label the page/events read in step.
      if (targetMethod === PaymentMethod.Crypto) {
        yield* payments.clearToken(paymentId);
        yield* payments.setMethod(paymentId, PaymentMethod.Crypto);
      } else {
        const token = recToken(event.payload);
        if (token !== null) {
          yield* payments.updateToken(paymentId, token);
        }
        yield* payments.setMethod(paymentId, PaymentMethod.Card);
      }
      // The next charge date this change establishes: for an owed change it advances the
      // anchor (below); otherwise the payment's existing schedule is unchanged.
      let nextPaymentDate: Date | null = null;
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
          nextPaymentDate = currentPeriodEnd;
        }
      }
      yield* checkout.markCompleted(event.externalRef);
      return { subscriptionId: paymentId, created: false, nextPaymentDate };
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
        // The session's method is the change's DESTINATION (Card re-tokenizes, Crypto
        // drops the token); the matcher lifted it onto the match.
        match.method,
      );
    }
    if (match.kind === 'recurring' && match.subscriptionId !== null) {
      const subscriptionId = match.subscriptionId;
      // A recurring match already has its payment (the scheduler advanced it before the
      // incoming event re-entered the pipeline), so read its new next-charge date to
      // report on the succeeded event.
      return Effect.gen(function* () {
        const found = yield* payments.findById(subscriptionId);
        const nextPaymentDate = Option.isSome(found)
          ? found.value.nextPaymentDate
          : null;
        return { subscriptionId, created: false, nextPaymentDate };
      });
    }
    return createOrExtend(payments)({
      externalUserId: match.externalUserId,
      amount: event.amount,
      currency: event.currency,
      method: match.method,
      period: match.period,
      // Absent on a recurring/card_change match — those act on an existing recurring
      // payment; only a checkout match can carry a one-time (false) intent.
      recurring: match.recurring ?? true,
      // One-time bonus period from the session; extends the paid-through anchor once.
      promoBonus: match.promoBonus ?? null,
      recurringTokenRef: recToken(event.payload),
      paidAt: event.occurredAt,
    }).pipe(Effect.tap(() => checkout.markCompleted(event.externalRef)));
  };
