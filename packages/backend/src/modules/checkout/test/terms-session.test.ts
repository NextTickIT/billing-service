import { it } from '@effect/vitest';
import {
  type CheckoutSession,
  CheckoutSessionKind,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { Charge } from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  cycleOptions,
  makeCardChangeMatcher,
  manualRenewalSession,
  prolongSession,
  subscriptionTermsSession,
} from '@/modules/checkout/domain.js';

const sub: Payment = {
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  method: PaymentMethod.Crypto,
  period: 'P4W',
  status: PaymentStatus.PastDue,
  recurring: true,
  currentPeriodStart: new Date('2026-09-03T00:00:00Z'),
  currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-10-01T00:00:00Z'),
  recurringTokenRef: null,
  firstFailureAt: new Date('2026-10-01T00:00:00Z'),
  retryAttempt: 1,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const EXPIRES = new Date('2026-10-08T00:00:00Z');

it('prolongSession is a recurring checkout at the sub terms, method-locked by origin', () => {
  expect(prolongSession(sub, 'chk_p', EXPIRES, 'idem-1')).toEqual({
    id: 'chk_p',
    externalUserId: 'sp:1',
    amount: 5000,
    currency: 1,
    period: 'P4W',
    method: PaymentMethod.Crypto,
    email: '',
    kind: CheckoutSessionKind.Checkout,
    recurring: true,
    paymentId: null,
    successUrl: null,
    failureUrl: null,
    promo: null,
    renewal: null,
    origin: 'prolong',
    renewalOf: 'sub_1',
    options: null,
    metadata: null,
    idempotencyKey: 'idem-1',
    expiresAt: EXPIRES,
  });
});

it.each([
  [
    '[1,3,6] stores one option per cycle count',
    [1, 3, 6],
    [{ cycles: 1 }, { cycles: 3 }, { cycles: 6 }],
  ],
  ['[1] stores no options', [1], null],
] as const)(
  'a pay-now prolong session with cycles %s',
  (_label, cycles, expected) => {
    const session = {
      ...prolongSession(sub, 'chk_pn', sub.nextPaymentDate, 'paynow:sub_1:1'),
      options: cycleOptions(cycles),
    };
    expect(session.options).toEqual(expected);
    expect(session).toMatchObject({
      origin: 'prolong',
      renewalOf: 'sub_1',
      method: PaymentMethod.Crypto,
      promo: null,
      renewal: null,
      expiresAt: sub.nextPaymentDate,
    });
  },
);

it('manualRenewalSession is the same session labelled manual_renewal', () => {
  expect(manualRenewalSession(sub, 'chk_m', EXPIRES, 'manual:sub_1:1')).toEqual(
    {
      ...prolongSession(sub, 'chk_m', EXPIRES, 'manual:sub_1:1'),
      origin: 'manual_renewal',
    },
  );
});

it('an unlabelled re-mint (origin null) names no subscription', () => {
  const session = subscriptionTermsSession(sub, {
    sessionId: 'chk_r',
    expiresAt: EXPIRES,
    idempotencyKey: null,
    origin: null,
  });
  expect(session.origin).toBeNull();
  expect(session.renewalOf).toBeNull();
  expect(session.idempotencyKey).toBeNull();
});

// ---- card-change matcher: arrears from mint-time origin, money from the charge ----

const cardChangeSession = (
  over: Partial<CheckoutSession>,
): CheckoutSession => ({
  ...prolongSession(sub, 'chk_cc', EXPIRES, null),
  method: PaymentMethod.Card,
  kind: CheckoutSessionKind.CardChange,
  paymentId: 'sub_1',
  origin: 'card_change',
  renewalOf: null,
  metadata: null,
  status: 0,
  createdAt: new Date(0),
  ...over,
});

const repoWith = (session: CheckoutSession): CheckoutRepo => ({
  findById: () => Effect.succeed(Option.some(session)),
  findByIdempotencyKey: () => Effect.die('unused'),
  reissueLapsed: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  claimForPayment: () => Effect.die('unused'),
  releasePending: () => Effect.die('unused'),
  completeIfOpen: () => Effect.die('unused'),
  renameOpenSessionsExternalUser: () => Effect.die('unused'),
});

const charge = (amount: number): Charge => ({
  source: 'wayforpay_callback',
  idemKey: 'k',
  externalRef: 'chk_cc',
  externalUserId: null,
  amount,
  currency: 1,
  status: 'succeeded',
  occurredAt: new Date(0),
  payload: {},
});

it.effect.each([
  ['card_change_arrears', 5000, true, true],
  ['card_change', 1, false, true],
  ['card_change', 0, false, false],
  // A session from before `origin`: the old rule, priced → arrears.
  [null, 5000, true, true],
  [null, 0, false, false],
] as const)(
  'origin %s, amount %d → arrears %s, amountCharged %s',
  ([origin, amount, arrears, amountCharged]) =>
    makeCardChangeMatcher(repoWith(cardChangeSession({ origin, amount })))(
      charge(amount),
    ).pipe(
      Effect.map((result) => {
        expect(result).toMatchObject({
          matched: true,
          kind: 'card_change',
          arrears,
          amountCharged,
          origin,
        });
      }),
    ),
);
