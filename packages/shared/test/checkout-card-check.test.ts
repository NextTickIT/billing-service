import { Either, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { CreateCheckoutSession } from '@/schemas/checkout.js';

const decode = Schema.decodeUnknownEither(CreateCheckoutSession);

/** A card-check create that keeps every rule (plan §1.1). */
const cardCheck = {
  externalUserId: '1001',
  amount: 5000,
  currency: 1,
  period: 'P4W',
  method: 0,
  lockMethod: true,
  startsAt: '2026-12-01T00:00:00.000Z',
  firstCharge: 'card_check',
};

const failure = (body: unknown): string => {
  const result = decode(body);
  return Either.isLeft(result) ? String(result.left) : 'decoded';
};

describe('CreateCheckoutSession.firstCharge', () => {
  test('a card check with recurring, startsAt, method 0 and lockMethod decodes', () => {
    const result = decode(cardCheck);

    expect(Either.getOrNull(result)?.firstCharge).toBe('card_check');
  });

  test.each([
    ['recurring: false', { recurring: false }, 'card_check requires recurring'],
    ['no startsAt', { startsAt: undefined }, 'card_check requires startsAt'],
    [
      'method 1 (crypto)',
      { method: 1 },
      'card_check requires method 0 with lockMethod',
    ],
    [
      'lockMethod false',
      { lockMethod: false },
      'card_check requires method 0 with lockMethod',
    ],
    [
      'a promo',
      { promo: { additionalFreePeriod: 'P7D' } },
      'card_check forbids promo, options and renewal',
    ],
    [
      'options',
      { options: [{ amount: 5000, period: 'P4W' }] },
      'card_check forbids promo, options and renewal',
    ],
    [
      'renewal terms',
      { renewal: { amount: 5000, period: 'P4W' } },
      'card_check forbids promo, options and renewal',
    ],
  ])('%s is refused', (_label, change, expectedMessage) => {
    const message = failure({ ...cardCheck, ...change });

    expect(message).toContain(expectedMessage);
  });
});

describe('CreateCheckoutSession.firstCharge on a full-price checkout', () => {
  test.each([
    ['absent', {}],
    ['"now"', { firstCharge: 'now' }],
  ])(
    'firstCharge %s keeps a full-price checkout free of the card-check rules',
    (_label, mode) => {
      const fullPrice = {
        externalUserId: '1001',
        amount: 5000,
        currency: 1,
        period: 'P4W',
        method: 1,
        promo: { additionalFreePeriod: 'P7D' },
        ...mode,
      };

      const result = decode(fullPrice);

      expect(Either.isRight(result)).toBe(true);
    },
  );

  test.each(['CARD_CHECK', 'verify', '', null])(
    'firstCharge %j is not a mode',
    (firstCharge) => {
      const result = decode({ ...cardCheck, firstCharge });

      expect(Either.isLeft(result)).toBe(true);
    },
  );
});
