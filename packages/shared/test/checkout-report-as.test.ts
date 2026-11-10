import { Either, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import { CreateCheckoutSession } from '@/schemas/checkout.js';

const decode = Schema.decodeUnknownEither(CreateCheckoutSession);

const base = {
  externalUserId: '1001',
  method: 1,
  amount: 5000,
  currency: 1,
  period: 'P1M',
};

const promo = { additionalFreePeriod: 'P7D' };
const renewal = { amount: 5000, period: 'P1M' };

const migration = {
  ...base,
  renewal,
  promo,
  options: [
    { amount: 5000, period: 'P1M', promo, renewal },
    { amount: 13500, period: 'P3M', promo, renewal },
    { amount: 24000, period: 'P6M', promo, renewal },
  ],
  reportAs: 'renewal',
};

const message = (body: unknown): string => {
  const r = decode(body);
  if (Either.isRight(r)) throw new Error('expected a decode failure');
  return String(r.left);
};

describe('CreateCheckoutSession.reportAs', () => {
  test('"renewal" decodes', () => {
    const r = decode({ ...base, recurring: true, reportAs: 'renewal' });
    expect(Either.isRight(r)).toBe(true);
    if (Either.isRight(r)) expect(r.right.reportAs).toBe('renewal');
  });

  test.each(['first', 'RENEWAL', '', true, null])(
    '%j is rejected',
    (reportAs) => {
      expect(
        Either.isLeft(decode({ ...base, recurring: true, reportAs })),
      ).toBe(true);
    },
  );

  test.each([true, false])(
    '"initial" decodes on a checkout with recurring: %j',
    (recurring) => {
      const r = decode({ ...base, recurring, reportAs: 'initial' });
      expect(Either.isRight(r)).toBe(true);
      if (Either.isRight(r)) expect(r.right.reportAs).toBe('initial');
    },
  );

  test('a non-recurring checkout with "renewal" is rejected with the filter message', () => {
    expect(
      message({ ...base, recurring: false, reportAs: 'renewal' }),
    ).toContain('reportAs: "renewal" is only allowed on a recurring checkout');
  });

  test('an absent flag decodes to the pre-change shape, defaults included', () => {
    // `recurring` is omitted on purpose: the decoder defaults it to true.
    const withoutFlag = decode({ ...base });
    expect(Either.isRight(withoutFlag)).toBe(true);
    if (Either.isRight(withoutFlag)) {
      expect('reportAs' in withoutFlag.right).toBe(false);
      expect(withoutFlag.right).toStrictEqual({
        externalUserId: '1001',
        method: 1,
        amount: 5000,
        currency: 1,
        period: 'P1M',
        recurring: true,
      });
    }
  });

  test('the worked migration example decodes', () => {
    const r = decode(migration);
    expect(Either.isRight(r)).toBe(true);
  });

  test('the same body without the promo on the options is rejected', () => {
    const stripped = {
      ...migration,
      options: migration.options.map((o) => ({
        amount: o.amount,
        period: o.period,
        renewal: o.renewal,
      })),
    };
    expect(message(stripped)).toContain(
      'the flat terms must equal one of the options',
    );
  });
});
