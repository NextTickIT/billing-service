import { Currency } from '@billing-service/shared';
import { describe, expect, test } from 'vitest';

import {
  toCurrency,
  toDate,
  toMinorUnits,
  whitePayStatus,
} from '@/modules/whitepay/mapping.js';

describe('toMinorUnits', () => {
  test('major-unit decimal → integer minor units', () => {
    expect(toMinorUnits('10.10')).toBe(1010);
    expect(toMinorUnits(10.1)).toBe(1010);
  });

  test('undefined/garbage → 0 (never NaN)', () => {
    expect(toMinorUnits(undefined)).toBe(0);
    expect(toMinorUnits('abc')).toBe(0);
  });
});

describe('toDate', () => {
  test('ISO-8601 string parses', () => {
    expect(toDate('2026-01-02T03:04:05Z').getTime()).toBe(
      Date.parse('2026-01-02T03:04:05Z'),
    );
  });

  test('bare number is treated as epoch seconds', () => {
    expect(toDate(1700000000).getTime()).toBe(1700000000 * 1000);
  });

  test('null/garbage falls back to epoch 0 (never Invalid Date)', () => {
    expect(toDate(null).getTime()).toBe(0);
    expect(toDate('not-a-date').getTime()).toBe(0);
  });
});

describe('toCurrency', () => {
  test('known ISO ticker maps to the enum', () => {
    expect(toCurrency('USD')).toBe(Currency.USD);
  });

  test('unknown/absent defaults to UAH', () => {
    expect(toCurrency('GBP')).toBe(Currency.UAH);
    expect(toCurrency(undefined)).toBe(Currency.UAH);
  });
});

describe('whitePayStatus', () => {
  test('COMPLETE succeeds', () => {
    expect(whitePayStatus('COMPLETE')).toBe('succeeded');
  });

  test('DECLINED and CANCELED fail', () => {
    expect(whitePayStatus('DECLINED')).toBe('failed');
    expect(whitePayStatus('CANCELED')).toBe('failed');
  });

  test('INIT/OPEN and PARTIALLY_FULFILLED are pending (not complete, not failed)', () => {
    expect(whitePayStatus('INIT')).toBe('pending');
    expect(whitePayStatus('OPEN')).toBe('pending');
    expect(whitePayStatus('PARTIALLY_FULFILLED')).toBe('pending');
  });

  test('an unknown status is unknown (falls through to quarantine)', () => {
    expect(whitePayStatus('WHATEVER')).toBe('unknown');
    expect(whitePayStatus(undefined)).toBe('unknown');
  });
});
