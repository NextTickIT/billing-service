import { describe, expect, test } from 'vitest';

import { addPeriod } from '@/modules/subscription/period.js';

const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('addPeriod', () => {
  test('adds a whole month keeping the day', () => {
    expect(iso(addPeriod(new Date('2026-01-15T00:00:00Z'), 'P1M'))).toBe(
      '2026-02-15',
    );
  });

  test('clamps to the last valid day (Jan 31 + P1M → Feb 28)', () => {
    expect(iso(addPeriod(new Date('2026-01-31T00:00:00Z'), 'P1M'))).toBe(
      '2026-02-28',
    );
  });

  test('clamps into a leap February (Jan 31 2024 + P1M → Feb 29)', () => {
    expect(iso(addPeriod(new Date('2024-01-31T00:00:00Z'), 'P1M'))).toBe(
      '2024-02-29',
    );
  });

  test('rolls the year over (Dec 31 + P1M → Jan 31)', () => {
    expect(iso(addPeriod(new Date('2025-12-31T00:00:00Z'), 'P1M'))).toBe(
      '2026-01-31',
    );
  });

  test('supports years, weeks, and days', () => {
    // Leap day + 1 year clamps to Feb 28 of the non-leap target year.
    expect(iso(addPeriod(new Date('2024-02-29T00:00:00Z'), 'P1Y'))).toBe(
      '2025-02-28',
    );
    expect(iso(addPeriod(new Date('2026-01-01T00:00:00Z'), 'P1W'))).toBe(
      '2026-01-08',
    );
    expect(iso(addPeriod(new Date('2026-01-01T00:00:00Z'), 'P10D'))).toBe(
      '2026-01-11',
    );
  });

  test('rejects an unsupported duration', () => {
    expect(() => addPeriod(new Date(), 'monthly')).toThrow();
    expect(() => addPeriod(new Date(), 'P')).toThrow();
  });
});
