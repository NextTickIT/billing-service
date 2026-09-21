import { it } from '@effect/vitest';
import {
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { Charge, Match } from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  makeCheckoutApplier,
  planMethodChange,
} from '@/modules/checkout/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

/**
 * Tests for the previous-method-agnostic payment-method change (docs/32):
 * `planMethodChange` (the pure owed/active × Card/Crypto decision the route branches on)
 * and the applier that lands a paid method-change on the payment. The applier records the
 * method ACTUALLY PAID, read off the callback payload: a `recToken` present → Card (store
 * the token); absent → Crypto (drop the token so the scheduler prompts a manual crypto
 * renewal). The session's requested method does not drive this branch.
 */

const CARD = PaymentMethod.Card;
const CRYPTO = PaymentMethod.Crypto;

const paymentWith = (status: PaymentStatus): Payment => ({
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: CARD,
  period: 'P1M',
  status,
  recurring: true,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
  recurringTokenRef: 'old-tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

// ---- planMethodChange: the owed/active × target-method decision matrix ----

it('active → crypto flips server-side (no payment): crypto has no free verify', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.Active),
    CRYPTO,
    true,
    1,
  );
  expect(plan).toEqual({ action: 'flip' });
});

it('active → card runs a 0-amount verify when card-verify is enabled', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.Active),
    CARD,
    true,
    1,
  );
  expect(plan).toEqual({ action: 'checkout', amount: 0 });
});

it('active → card falls back to a minimal tokenizing charge when verify is off', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.Active),
    CARD,
    false,
    1,
  );
  expect(plan).toEqual({ action: 'checkout', amount: 1 });
});

it('owed → crypto bills the arrears amount (never a free flip)', () => {
  for (const status of [PaymentStatus.PastDue, PaymentStatus.RenewalFailed]) {
    const plan = planMethodChange(paymentWith(status), CRYPTO, true, 1);
    expect(plan).toEqual({ action: 'checkout', amount: 30000 });
  }
});

it('owed → card bills the arrears amount (verify config ignored)', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.PastDue),
    CARD,
    true,
    1,
  );
  expect(plan).toEqual({ action: 'checkout', amount: 30000 });
});

// ---- applier: how a paid method-change lands on the payment ----

const event = (
  payload: Record<string, unknown>,
  source = 'wayforpay_callback',
): Charge => ({
  source,
  idemKey: 'k',
  externalRef: 'chk_1',
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date('2026-01-20T00:00:00Z'),
  payload,
});

// The `method` arg fills the match's `method` field but NO LONGER drives the applier's
// branch — the applier keys on the event SOURCE (whitepay_callback → Crypto; any WayForPay
// source → Card). It is kept only to build a well-formed match.
const cardChangeMatch = (method: number, owed: boolean): Match => ({
  matched: true,
  kind: 'card_change',
  subscriptionId: 'sub_1',
  externalUserId: 'sp:1',
  period: 'P1M',
  method,
  owed,
});

/** A repo that records the mutations the applier makes, dying on anything unexpected. */
const recordingRepo = () => {
  const calls = {
    updatedToken: null as string | null,
    clearedToken: false,
    setMethod: null as number | null,
    advanced: false,
  };
  const die = () => Effect.die('unused');
  const repo: PaymentRepo = {
    findActiveRecurringByExternalUser: die,
    findById: () =>
      Effect.succeed(Option.some(paymentWith(PaymentStatus.PastDue))),
    findDue: die,
    insert: die,
    extend: die,
    advanceAfterSuccess: () =>
      Effect.sync(() => {
        calls.advanced = true;
      }),
    recordRetry: die,
    markRenewalFailed: die,
    findByExternalUser: die,
    findByContactName: die,
    listAll: die,
    requestCancel: die,
    clearCancelRequest: die,
    markCancelledLapsed: die,
    cancelUpstream: die,
    defer: die,
    updateToken: (_id, token) =>
      Effect.sync(() => {
        calls.updatedToken = token;
      }),
    setMethod: (_id, method) =>
      Effect.sync(() => {
        calls.setMethod = method;
      }),
    clearToken: () =>
      Effect.sync(() => {
        calls.clearedToken = true;
      }),
    renameExternalUser: die,
  };
  return { calls, repo };
};

const completingCheckout = (onComplete: () => void): CheckoutRepo => ({
  findById: () => Effect.die('unused'),
  findByIdempotencyKey: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  claimForPayment: () => Effect.die('unused'),
  releasePending: () => Effect.die('unused'),
  markCompleted: () => Effect.sync(onComplete),
  renameOpenSessionsExternalUser: () => Effect.die('unused'),
});

it.effect(
  'a WayForPay callback with a recToken records Card: stores the new token, never clearing',
  () =>
    Effect.gen(function* () {
      const { calls, repo } = recordingRepo();
      let completed = false;
      const checkout = completingCheckout(() => {
        completed = true;
      });

      // WayForPay (card) success with a recToken → CARD: tokenize the new card, no arrears
      // advance (owed=false, active card verify).
      const result = yield* makeCheckoutApplier(repo, checkout)(
        event({ recToken: 'new-tok' }),
        cardChangeMatch(CARD, false),
      );

      expect(calls.updatedToken).toBe('new-tok');
      expect(calls.setMethod).toBe(CARD);
      expect(calls.clearedToken).toBe(false);
      expect(calls.advanced).toBe(false);
      expect(completed).toBe(true);
      expect(result).toEqual({
        subscriptionId: 'sub_1',
        created: false,
        nextPaymentDate: null,
      });
    }),
);

it.effect(
  'REGRESSION: a WayForPay success with NO recToken stays Card and NEVER clears the token',
  () =>
    Effect.gen(function* () {
      const { calls, repo } = recordingRepo();
      const checkout = completingCheckout(() => {});

      // An Approved WayForPay charge can omit recToken (docs/14). It must keep the sub on
      // card: do NOT clear the existing token (that would silently strip a live card sub to
      // manual). Store nothing (no new token), leave method Card.
      yield* makeCheckoutApplier(repo, checkout)(
        event({}), // wayforpay_callback, no recToken
        cardChangeMatch(CARD, false),
      );

      expect(calls.clearedToken).toBe(false); // the regression this guards against
      expect(calls.updatedToken).toBeNull(); // nothing new to store
      expect(calls.setMethod).toBe(CARD);
    }),
);

it.effect(
  'a WhitePay callback records Crypto: drops the card token (manual renewal next cycle)',
  () =>
    Effect.gen(function* () {
      const { calls, repo } = recordingRepo();
      const checkout = completingCheckout(() => {});

      // WhitePay (crypto) success → CRYPTO: an owed crypto change pays arrears in crypto,
      // advances, and clears the token so the scheduler's token-less branch prompts a manual
      // crypto renewal next cycle.
      const result = yield* makeCheckoutApplier(repo, checkout)(
        event({}, 'whitepay_callback'),
        cardChangeMatch(CRYPTO, true),
      );

      expect(calls.clearedToken).toBe(true);
      expect(calls.setMethod).toBe(CRYPTO);
      expect(calls.updatedToken).toBeNull();
      expect(calls.advanced).toBe(true); // owed → revived in place
      expect(result.subscriptionId).toBe('sub_1');
    }),
);
