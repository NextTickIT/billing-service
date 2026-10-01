import { describe, expect, test } from 'vitest';

import { formattedFields } from '@/modules/sinks/formatted.js';

describe('dates render as DD.MM.YYYY in Kyiv', () => {
  test('formats each known date field', () => {
    expect(
      formattedFields({ nextPaymentDate: '2026-10-02T09:00:00.000Z' }),
    ).toEqual({ nextPaymentDate_formatted: '02.10.2026' });
  });

  test('uses Kyiv, not UTC — a late-evening charge is the NEXT day locally', () => {
    // 21:30 UTC is 00:30 Kyiv the following day. Naming the wrong day in a "we charge
    // you tomorrow" message is the whole reason the zone is pinned.
    expect(formattedFields({ chargeDate: '2026-10-02T21:30:00.000Z' })).toEqual(
      {
        chargeDate_formatted: '03.10.2026',
      },
    );
  });

  test('pads single digits', () => {
    expect(formattedFields({ dueDate: '2026-01-05T12:00:00.000Z' })).toEqual({
      dueDate_formatted: '05.01.2026',
    });
  });

  test.each([
    'nextPaymentDate',
    'nextRetryDate',
    'dueDate',
    'windowExpiresAt',
    'newPeriodEnd',
    'chargeDate',
  ])('%s is covered', (field) => {
    expect(formattedFields({ [field]: '2026-03-09T10:00:00.000Z' })).toEqual({
      [`${field}_formatted`]: '09.03.2026',
    });
  });
});

describe('periods render in Russian with correct plurals', () => {
  test.each([
    ['P1M', '1 месяц'],
    ['P2M', '2 месяца'],
    ['P4M', '4 месяца'],
    ['P5M', '5 месяцев'],
    ['P1W', '1 неделя'],
    ['P2W', '2 недели'],
    ['P4W', '4 недели'],
    ['P5W', '5 недель'],
    ['P1Y', '1 год'],
    ['P30D', '30 дней'],
  ])('%s -> %s', (period, expected) => {
    expect(formattedFields({ period })).toEqual({
      period_formatted: expected,
    });
  });
});

describe('renders nothing rather than something wrong', () => {
  test('a one-time purchase carries nextPaymentDate: null — no twin', () => {
    expect(formattedFields({ nextPaymentDate: null })).toEqual({});
  });

  test('the P0D one-time sentinel is omitted, never shown to a customer', () => {
    expect(formattedFields({ period: 'P0D' })).toEqual({});
  });

  test('an unparseable date is omitted rather than rendered "Invalid Date"', () => {
    expect(formattedFields({ dueDate: 'not-a-date' })).toEqual({});
  });

  test('leaves unrelated fields alone', () => {
    expect(
      formattedFields({
        amount: 5000,
        currency: 1,
        reason: 'Insufficient funds',
      }),
    ).toEqual({});
  });

  test('a field that merely looks date-ish is not formatted', () => {
    // `source` and `reason` are free text; sniffing would eventually mangle one.
    expect(
      formattedFields({ source: '2026-10-02', reason: '2026-10-02' }),
    ).toEqual({});
  });
});

describe('drift guard', () => {
  // Mirrors the documented payload fields (domain-events.md "Quick reference"). If an
  // event gains a date field, add it here AND to DATE_FIELDS — this test is what stops
  // a new event shipping to SendPulse without its formatted twin.
  const DOCUMENTED_DATE_FIELDS = [
    'nextPaymentDate', // initial/recurring/one_time succeeded
    'nextRetryDate', // charge_retry_failed
    'dueDate', // payment_manual_required
    'windowExpiresAt', // payment_manual_required
    'newPeriodEnd', // payment_deferred
    'chargeDate', // upcoming_charge
  ];

  test.each(DOCUMENTED_DATE_FIELDS)(
    'documented date field %s produces a formatted twin',
    (field) => {
      const out = formattedFields({ [field]: '2026-12-31T00:00:00.000Z' });
      expect(Object.keys(out)).toEqual([`${field}_formatted`]);
    },
  );
});
