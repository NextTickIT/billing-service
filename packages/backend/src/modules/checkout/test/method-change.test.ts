import { it } from '@effect/vitest';
import {
  type CheckoutOrigin,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { Charge, Match } from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  changeablePayment,
  isPageFlip,
  isSwitchShaped,
  makeCheckoutApplier,
  planMethodChange,
} from '@/modules/checkout/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import type { ApprovalLookup } from '@/modules/charge/contracts.js';

/** An approval recorded before the ledger kept snapshots: the row is the report. */
const legacyApproval: ApprovalLookup = () => Effect.succeed(Option.some(true));

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
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

// ---- changeablePayment: which of a user's payments (newest first) a change acts on ----

const row = (id: string, status: PaymentStatus, recurring = true): Payment => ({
  ...paymentWith(status),
  id,
  recurring,
});

it.each([
  [
    'an older live payment behind a newer cancelled one',
    [row('new', PaymentStatus.Cancelled), row('old', PaymentStatus.Active)],
    'old',
  ],
  [
    'the newest live payment over an older cancelled one',
    [row('new', PaymentStatus.Active), row('old', PaymentStatus.Cancelled)],
    'new',
  ],
  [
    'an owed payment (renewal failed) behind a newer cancelled one',
    [
      row('new', PaymentStatus.Cancelled),
      row('old', PaymentStatus.RenewalFailed),
    ],
    'old',
  ],
  [
    'the recurring payment behind a newer one-time payment',
    [
      row('once', PaymentStatus.Active, false),
      row('sub', PaymentStatus.PastDue),
    ],
    'sub',
  ],
] as const)('a change acts on %s', (_, payments, expectedId) => {
  const result = changeablePayment(payments);

  expect(result?.id).toBe(expectedId);
});

it.each([
  ['the user has no payments', []],
  [
    'every recurring payment is cancelled',
    [row('a', PaymentStatus.Cancelled), row('b', PaymentStatus.Cancelled)],
  ],
  [
    'the only live payment is one-time',
    [row('once', PaymentStatus.Active, false)],
  ],
] as const)('no payment is changeable when %s', (_, payments) => {
  const result = changeablePayment(payments);

  expect(result).toBeUndefined();
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
  expect(plan).toEqual({ action: 'checkout', amount: 0, arrears: false });
});

it('active → card falls back to a minimal tokenizing charge when verify is off', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.Active),
    CARD,
    false,
    1,
  );
  expect(plan).toEqual({ action: 'checkout', amount: 1, arrears: false });
});

it('owed → crypto bills the arrears amount (never a free flip)', () => {
  for (const status of [PaymentStatus.PastDue, PaymentStatus.RenewalFailed]) {
    const plan = planMethodChange(paymentWith(status), CRYPTO, true, 1);
    expect(plan).toEqual({
      action: 'checkout',
      amount: 30000,
      arrears: true,
    });
  }
});

it('owed → card bills the arrears amount (verify config ignored)', () => {
  const plan = planMethodChange(
    paymentWith(PaymentStatus.PastDue),
    CARD,
    true,
    1,
  );
  expect(plan).toEqual({
    action: 'checkout',
    amount: 30000,
    arrears: true,
  });
});

// ---- method-less request: the payer picks on the page, so it is always a checkout ----

const ARREARS = 30000;
const TOKEN_CHARGE = 1;

const VERIFY_PRICE = 0;

it.each([
  {
    state: 'active',
    status: PaymentStatus.Active,
    verify: true,
    amount: VERIFY_PRICE,
    arrears: false,
  },
  {
    state: 'active',
    status: PaymentStatus.Active,
    verify: false,
    amount: TOKEN_CHARGE,
    arrears: false,
  },
  {
    state: 'past due',
    status: PaymentStatus.PastDue,
    verify: true,
    amount: ARREARS,
    arrears: true,
  },
  {
    state: 'past due',
    status: PaymentStatus.PastDue,
    verify: false,
    amount: ARREARS,
    arrears: true,
  },
  {
    state: 'renewal failed',
    status: PaymentStatus.RenewalFailed,
    verify: true,
    amount: ARREARS,
    arrears: true,
  },
  {
    state: 'renewal failed',
    status: PaymentStatus.RenewalFailed,
    verify: false,
    amount: ARREARS,
    arrears: true,
  },
])(
  'no target method on a $state sub (verify on: $verify) issues a checkout, never the flip',
  ({ status, verify, amount, arrears }) => {
    const plan = planMethodChange(
      paymentWith(status),
      undefined,
      verify,
      TOKEN_CHARGE,
    );

    expect(plan).toEqual({ action: 'checkout', amount, arrears });
  },
);

// ---- isPageFlip: which /pay pick lands as the no-payment flip ----

const changeLink = (
  origin: CheckoutOrigin | null,
  method: PaymentMethod | null,
  kind = CheckoutSessionKind.CardChange,
) => ({ kind, origin, method });

it.each([
  {
    pick: 'crypto on a method-less up-to-date change link',
    session: changeLink('card_change', null),
    method: CRYPTO,
    expected: true,
  },
  {
    pick: 'card on a method-less up-to-date change link',
    session: changeLink('card_change', null),
    method: CARD,
    expected: false,
  },
  {
    pick: 'crypto on a method-less owed change link (a crypto purchase of the arrears)',
    session: changeLink('card_change_arrears', null),
    method: CRYPTO,
    expected: false,
  },
  {
    pick: 'crypto on a change link minted for card',
    session: changeLink('card_change', CARD),
    method: CRYPTO,
    expected: false,
  },
  {
    pick: 'crypto on a plain checkout with no method',
    session: changeLink(null, null, CheckoutSessionKind.Checkout),
    method: CRYPTO,
    expected: false,
  },
])('$pick → flip: $expected', ({ session, method, expected }) => {
  expect(isPageFlip(session, method)).toBe(expected);
});

// ---- isSwitchShaped: which used-up link the no-payment flip could have completed ----

const usedLink = (
  overrides: Partial<{
    kind: CheckoutSessionKind;
    origin: CheckoutOrigin | null;
    status: CheckoutSessionStatus;
    method: PaymentMethod | null;
  }> = {},
) => ({
  kind: CheckoutSessionKind.CardChange,
  origin: 'card_change' as CheckoutOrigin | null,
  status: CheckoutSessionStatus.Completed,
  method: CRYPTO as PaymentMethod | null,
  ...overrides,
});

it.each([
  {
    link: 'a completed up-to-date change link that ended on crypto',
    session: usedLink(),
    expected: true,
  },
  {
    link: 'the same link still open',
    session: usedLink({ status: CheckoutSessionStatus.Created, method: null }),
    expected: false,
  },
  {
    link: 'a completed change link that ended on card',
    session: usedLink({ method: CARD }),
    expected: false,
  },
  {
    link: 'a completed owed change link paid in crypto',
    session: usedLink({ origin: 'card_change_arrears' }),
    expected: false,
  },
  {
    link: 'a completed crypto checkout',
    session: usedLink({ kind: CheckoutSessionKind.Checkout, origin: null }),
    expected: false,
  },
])('$link → switch-shaped: $expected', ({ session, expected }) => {
  expect(isSwitchShaped(session)).toBe(expected);
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
  amountCharged: owed,
  arrears: owed,
  origin: owed ? 'card_change_arrears' : 'card_change',
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
    transaction: (effect) => effect,
    lockById: () =>
      Effect.succeed(Option.some(paymentWith(PaymentStatus.PastDue))),
    findById: () =>
      Effect.succeed(Option.some(paymentWith(PaymentStatus.PastDue))),
    findDue: die,
    findUpcomingForNotice: die,
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
    deferCharge: die,
    markFirstMoney: () => Effect.void,
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
    setEmail: () => Effect.succeed(0),
    renameExternalUser: die,
  };
  return { calls, repo };
};

const completingCheckout = (onComplete: () => void): CheckoutRepo => ({
  findById: () => Effect.die('unused'),
  everSentToProvider: () => Effect.die('unused'),
  findByIdempotencyKey: () => Effect.die('unused'),
  reissueLapsed: () => Effect.die('unexpected reissueLapsed'),
  insert: () => Effect.die('unused'),
  claimForPayment: () => Effect.die('unused'),
  claimAsApplied: () => Effect.die('unused'),
  releasePending: () => Effect.die('unused'),
  completeIfOpen: () => Effect.sync(onComplete).pipe(Effect.as(true)),
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
      const result = yield* makeCheckoutApplier(
        repo,
        checkout,
        legacyApproval,
      )(event({ recToken: 'new-tok' }), cardChangeMatch(CARD, false));

      expect(calls.updatedToken).toBe('new-tok');
      expect(calls.setMethod).toBe(CARD);
      expect(calls.clearedToken).toBe(false);
      expect(calls.advanced).toBe(false);
      expect(completed).toBe(true);
      expect(result).toEqual({
        subscriptionId: 'sub_1',
        created: false,
        prolonged: false,
        // A 0-amount verify changes the card, not the schedule: no window was bought, so
        // the applier reports none rather than inventing one.
        nextPaymentDate: null,
        periodStart: null,
        periodEnd: null,
        metadata: null,
        nextAmount: null,
        creditsPeriod: false,
      });
    }),
);

it.effect(
  'a card change that moved money but credited no period reports the next autocharge of the row',
  () =>
    Effect.gen(function* () {
      const { repo } = recordingRepo();
      const checkout = completingCheckout(() => undefined);

      const result = yield* makeCheckoutApplier(
        repo,
        checkout,
        legacyApproval,
      )(event({ recToken: 'new-tok' }), {
        ...cardChangeMatch(CARD, false),
        amountCharged: true,
      });

      expect(result).toMatchObject({
        nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
        nextAmount: 30000,
      });
    }),
);

it.effect(
  'REGRESSION: a WayForPay success with NO recToken stays Card and NEVER clears the token',
  () =>
    Effect.gen(function* () {
      const { calls, repo } = recordingRepo();
      const checkout = completingCheckout(() => undefined);

      // An Approved WayForPay charge can omit recToken (docs/14). It must keep the sub on
      // card: do NOT clear the existing token (that would silently strip a live card sub to
      // manual). Store nothing (no new token), leave method Card.
      yield* makeCheckoutApplier(
        repo,
        checkout,
        legacyApproval,
      )(
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
      const checkout = completingCheckout(() => undefined);

      // WhitePay (crypto) success → CRYPTO: an owed crypto change pays arrears in crypto,
      // advances, and clears the token so the scheduler's token-less branch prompts a manual
      // crypto renewal next cycle.
      const result = yield* makeCheckoutApplier(
        repo,
        checkout,
        legacyApproval,
      )(event({}, 'whitepay_callback'), cardChangeMatch(CRYPTO, true));

      expect(calls.clearedToken).toBe(true);
      expect(calls.setMethod).toBe(CRYPTO);
      expect(calls.updatedToken).toBeNull();
      expect(calls.advanced).toBe(true); // owed → revived in place
      expect(result.subscriptionId).toBe('sub_1');
    }),
);
