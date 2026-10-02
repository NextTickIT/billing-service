import { Either, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { isNonZeroPeriod, isValidPeriod } from '@/period.js';
import {
  CheckoutSessionPublic,
  CreateCheckoutSession,
  ProlongRequest,
} from '@/schemas/checkout.js';
import { DomainEvent, EVENT_NAMES } from '@/schemas/event.js';
import { Currency, PaymentMethod } from '@/schemas/payment.js';

const decode = Schema.decodeUnknownEither(CreateCheckoutSession);

const recurring = {
  externalUserId: 'guildmaster:1',
  amount: 5000,
  currency: Currency.USD,
  method: PaymentMethod.Card,
  period: 'P8W',
};

const accepts = (body: unknown): void => {
  expect(Either.isRight(decode(body))).toBe(true);
};
const rejects = (body: unknown): void => {
  expect(Either.isLeft(decode(body))).toBe(true);
};

describe('CreateCheckoutSession.renewal', () => {
  test('a valid renewal decodes and is carried through', () => {
    const decoded = decode({
      ...recurring,
      renewal: { amount: 5000, period: 'P4W' },
    });
    expect(Either.getOrThrow(decoded).renewal).toEqual({
      amount: 5000,
      period: 'P4W',
    });
  });

  test('renewal is optional', () => {
    const decoded = decode(recurring);
    expect(Either.getOrThrow(decoded).renewal).toBeUndefined();
  });

  test.each([
    ['missing amount', { period: 'P4W' }],
    ['missing period', { amount: 5000 }],
    ['a non-ISO period', { amount: 5000, period: '4W' }],
    ['a bare P', { amount: 5000, period: 'P' }],
    ['a zero-length P0D', { amount: 5000, period: 'P0D' }],
    ['a time-part PT0S', { amount: 5000, period: 'PT0S' }],
    ['a zero amount', { amount: 0, period: 'P4W' }],
    ['a negative amount', { amount: -1, period: 'P4W' }],
    ['a fractional amount', { amount: 1.5, period: 'P4W' }],
  ])('rejects a renewal with %s', (_label, renewal) => {
    rejects({ ...recurring, renewal });
  });

  test('rejects renewal on a one-time checkout', () => {
    rejects({
      ...recurring,
      recurring: false,
      renewal: { amount: 5000, period: 'P4W' },
    });
  });
});

describe('CreateCheckoutSession top-level terms (recurring)', () => {
  test.each(['1 month', 'P0D', 'P0Y0M0W0D', 'P', ''])(
    'rejects period %j on a recurring checkout',
    (period) => {
      rejects({ ...recurring, period });
      rejects({ ...recurring, recurring: true, period });
    },
  );

  test.each([0, -100])(
    'rejects amount %d on a recurring checkout',
    (amount) => {
      rejects({ ...recurring, amount });
    },
  );

  test.each(['P1M', 'P4W', 'P8W', 'P30D', 'P1Y', 'P0Y1M'])(
    'accepts period %s',
    (period) => {
      accepts({ ...recurring, period });
    },
  );

  // The read-only prod inventory (plan S1, 2026-10-15): every recurring (period, amount)
  // a live GM flow sends must keep decoding.
  test.each([
    ['P4W', 5000],
    ['P1M', 5000],
    ['P8W', 10000],
  ] as const)('keeps accepting prod terms %s / %d', (period, amount) => {
    accepts({ ...recurring, period, amount });
  });
});

describe('CreateCheckoutSession one-time', () => {
  test('P0D, or no period, still decodes for a one-time checkout', () => {
    accepts({ ...recurring, recurring: false, period: 'P0D' });
    accepts({ ...recurring, period: undefined, recurring: false });
  });

  test.each([0, -100])('rejects amount %d on a one-time checkout', (amount) => {
    rejects({ ...recurring, recurring: false, period: 'P0D', amount });
    rejects({ ...recurring, recurring: false, period: undefined, amount });
  });
});

describe('period validators', () => {
  test('isValidPeriod keeps accepting P0D (the one-time sentinel)', () => {
    expect(isValidPeriod('P0D')).toBe(true);
  });

  test.each([
    ['P1M', true, true],
    ['P4W', true, true],
    ['P1Y2M3W4D', true, true],
    ['P0D', true, false],
    ['P0M0D', true, false],
    ['P', false, false],
    ['PT0S', false, false],
    ['4W', false, false],
    ['', false, false],
  ] as const)('%j: valid=%s, non-zero=%s', (period, valid, nonZero) => {
    expect(isValidPeriod(period)).toBe(valid);
    expect(isNonZeroPeriod(period)).toBe(nonZero);
  });
});

describe('public session and prolong contracts', () => {
  test('the public session never carries origin or renewalOf', () => {
    const decoded = Schema.decodeUnknownSync(CheckoutSessionPublic)({
      amount: 5000,
      currency: Currency.USD,
      period: 'P4W',
      recurring: true,
      status: 0,
      kind: 0,
      method: PaymentMethod.Card,
      successUrl: null,
      failureUrl: null,
      expiresAt: new Date(0).toISOString(),
      renewal: null,
      methodLocked: true,
      prolong: true,
      options: [
        {
          amount: 5000,
          period: 'P4W',
          promo: null,
          renewal: null,
          cycles: null,
        },
      ],
      defaultOption: 0,
      // Internal columns a careless spread would leak: dropped, never echoed.
      origin: 'card_change_arrears',
      renewalOf: 'sub_1',
      externalUserId: 'sp:1',
    });
    expect(decoded).toMatchObject({
      renewal: null,
      methodLocked: true,
      prolong: true,
    });
    expect(decoded).not.toHaveProperty('origin');
    expect(decoded).not.toHaveProperty('renewalOf');
    expect(decoded).not.toHaveProperty('externalUserId');
  });

  test('ProlongRequest takes only externalUserId', () => {
    expect(Object.keys(ProlongRequest.fields)).toEqual(['externalUserId']);
  });
});

describe('events', () => {
  test('recurring_payment_failed is a known event name', () => {
    expect(EVENT_NAMES).toContain('recurring_payment_failed');
  });

  const envelope = {
    id: 'evt_1',
    occurredAt: new Date(0).toISOString(),
    correlationId: 'c',
    aggregateId: 'sub_1',
    externalUserId: 'sp:1',
  };

  test('recurring_payment_failed carries the initial_payment_failed payload', () => {
    const decoded = Schema.decodeUnknownEither(DomainEvent)({
      ...envelope,
      name: 'recurring_payment_failed',
      payload: {
        amount: 5000,
        currency: Currency.USD,
        method: PaymentMethod.Card,
        period: 'P4W',
        reason: 'declined',
        source: 'wayforpay_callback',
      },
    });
    expect(Either.isRight(decoded)).toBe(true);
  });

  test('payment_created carries renewal, null when the checkout set none', () => {
    const created = (renewal: unknown) =>
      Schema.decodeUnknownEither(DomainEvent)({
        ...envelope,
        name: 'payment_created',
        payload: {
          amount: 5000,
          currency: Currency.USD,
          method: PaymentMethod.Card,
          period: 'P8W',
          renewal,
          metadata: null,
        },
      });
    expect(Either.isRight(created({ amount: 5000, period: 'P4W' }))).toBe(true);
    expect(Either.isRight(created(null))).toBe(true);
  });
});
