import { Either, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { scalePeriod } from '@/period.js';
import {
  checkoutRef,
  CreateCheckoutSession,
  parseCheckoutRef,
  SelectMethod,
} from '@/schemas/checkout.js';
import { Currency, PaymentMethod } from '@/schemas/payment.js';

const decode = Schema.decodeUnknownEither(CreateCheckoutSession);

const flat = {
  externalUserId: 'guildmaster:1',
  amount: 5000,
  currency: Currency.USD,
  method: PaymentMethod.Card,
  period: 'P4W',
};

const threeCycles = {
  amount: 13000,
  period: 'P12W',
  promo: { additionalFreePeriod: 'P7D' },
  renewal: { amount: 5000, period: 'P4W' },
};

const accepts = (body: unknown): void => {
  expect(Either.isRight(decode(body))).toBe(true);
};
const rejects = (body: unknown): void => {
  expect(Either.isLeft(decode(body))).toBe(true);
};

describe('CreateCheckoutSession.options', () => {
  test('no options: decodes exactly as before', () => {
    const decoded = Either.getOrThrow(decode(flat));
    expect(decoded.options).toBeUndefined();
    expect(decoded.amount).toBe(5000);
  });

  test('options that include the flat terms decode and are carried through', () => {
    const options = [{ amount: 5000, period: 'P4W' }, threeCycles];
    expect(Either.getOrThrow(decode({ ...flat, options })).options).toEqual(
      options,
    );
  });

  test('the flat terms may sit anywhere in the list, promo and renewal included', () => {
    accepts({
      ...flat,
      ...threeCycles,
      options: [{ amount: 5000, period: 'P4W' }, threeCycles],
    });
  });

  test.each([
    ['a different amount', [{ amount: 5001, period: 'P4W' }]],
    ['a different period', [{ amount: 5000, period: 'P28D' }]],
    [
      'a promo the flat terms lack',
      [{ amount: 5000, period: 'P4W', promo: { additionalFreePeriod: 'P7D' } }],
    ],
    [
      'a renewal the flat terms lack',
      [
        {
          amount: 5000,
          period: 'P4W',
          renewal: { amount: 4000, period: 'P4W' },
        },
      ],
    ],
  ])(
    'rejects options whose terms miss the flat ones (%s)',
    (_label, options) => {
      rejects({ ...flat, options });
    },
  );
});

describe('CreateCheckoutSession.options rules', () => {
  test.each([
    ['a zero amount', { amount: 0, period: 'P4W' }],
    ['a missing period on a recurring checkout', { amount: 5000 }],
    ['a zero-length period', { amount: 5000, period: 'P0D' }],
    ['a non-ISO period', { amount: 5000, period: '4W' }],
    [
      'a bad renewal',
      { amount: 5000, period: 'P4W', renewal: { amount: 0, period: 'P4W' } },
    ],
  ])('holds every option to the flat rules: rejects %s', (_label, bad) => {
    rejects({ ...flat, options: [{ amount: 5000, period: 'P4W' }, bad] });
  });

  test('a renewal on a one-time option is refused like a flat one', () => {
    const oneTime = { ...flat, recurring: false, period: undefined };
    accepts({ ...oneTime, options: [{ amount: 5000 }, { amount: 9000 }] });
    rejects({
      ...oneTime,
      options: [
        { amount: 5000 },
        { amount: 9000, renewal: { amount: 5000, period: 'P4W' } },
      ],
    });
  });

  test('1 to 10 options', () => {
    const one = { amount: 5000, period: 'P4W' };
    rejects({ ...flat, options: [] });
    accepts({ ...flat, options: Array.from({ length: 10 }, () => one) });
    rejects({ ...flat, options: Array.from({ length: 11 }, () => one) });
  });
});

describe('SelectMethod.option', () => {
  const pick = Schema.decodeUnknownEither(SelectMethod);
  test('optional, a non-negative index', () => {
    expect(Either.isRight(pick({ method: 0 }))).toBe(true);
    expect(Either.isRight(pick({ method: 0, option: 2 }))).toBe(true);
    expect(Either.isLeft(pick({ method: 0, option: -1 }))).toBe(true);
    expect(Either.isLeft(pick({ method: 0, option: 1.5 }))).toBe(true);
  });
});

const ID = 'chk_0b5e6a3c-1f2d-4c7b-9a8e-1234567890ab';

describe('checkout order references', () => {
  test.each([
    [ID, { kind: 'default' }],
    [`${ID}_o0`, { kind: 'option', index: 0 }],
    [`${ID}_o2`, { kind: 'option', index: 2 }],
    [`${ID}_c3`, { kind: 'cycles', cycles: 3 }],
    [`${ID}_c12`, { kind: 'cycles', cycles: 12 }],
  ])('%s parses to its session and choice', (ref, choice) => {
    expect(parseCheckoutRef(ref)).toEqual({ sessionId: ID, choice });
  });

  test.each([
    `${ID}_c1`,
    `${ID}_c0`,
    `${ID}_o01`,
    `${ID}_x3`,
    `${ID}_o`,
    `${ID}_o2_c3`,
    `${ID}x`,
  ])('rejects %s', (ref) => {
    expect(parseCheckoutRef(ref)).toBeNull();
  });

  test('a reference that is not a minted session id stands for itself', () => {
    expect(parseCheckoutRef('chk_t31_manual')).toEqual({
      sessionId: 'chk_t31_manual',
      choice: { kind: 'default' },
    });
    expect(parseCheckoutRef('sub_1_2026')).toEqual({
      sessionId: 'sub_1_2026',
      choice: { kind: 'default' },
    });
  });

  test('checkoutRef and parseCheckoutRef round-trip', () => {
    for (const choice of [
      { kind: 'default' },
      { kind: 'option', index: 4 },
      { kind: 'cycles', cycles: 6 },
    ] as const) {
      expect(parseCheckoutRef(checkoutRef(ID, choice))).toEqual({
        sessionId: ID,
        choice,
      });
    }
  });
});

test('scalePeriod multiplies every component', () => {
  expect(scalePeriod('P4W', 3)).toBe('P12W');
  expect(scalePeriod('P1M', 6)).toBe('P6M');
  expect(scalePeriod('P1Y2M', 2)).toBe('P2Y4M');
  expect(scalePeriod('P1M15D', 3)).toBe('P3M45D');
  expect(scalePeriod('P4W', 1)).toBe('P4W');
});
