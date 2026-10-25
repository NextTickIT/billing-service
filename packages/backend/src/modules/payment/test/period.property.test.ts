import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { addDays, addPeriod, isValidPeriod } from '@/modules/payment/period.js';

const DAY_MS = 86_400_000;

// Whole UTC instants keep the day arithmetic exact; the range stays far from the
// Date limits so a span can never overflow into an invalid date.
const utcDate = fc.date({
  min: new Date(Date.UTC(1990, 0, 1)),
  max: new Date(Date.UTC(2100, 11, 31)),
  noInvalidDate: true,
});
const span = fc.integer({ min: 0, max: 400 });
const monthSpan = fc.integer({ min: 0, max: 240 });

const monthIndex = (date: Date): number =>
  date.getUTCFullYear() * 12 + date.getUTCMonth();

const lastDayOfMonth = (date: Date): number =>
  new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();

const expectedMonthDay = (from: Date, to: Date): number =>
  Math.min(from.getUTCDate(), lastDayOfMonth(to));

const component = (count: number | null, unit: string): string =>
  count === null ? '' : `${String(count)}${unit}`;

// Mixes arbitrary strings with well-formed P…Y…M…W…D shapes (including the bare
// 'P'), so both sides of the validator are exercised, not just random garbage.
const period = fc.oneof(
  fc.string(),
  fc
    .tuple(fc.option(span), fc.option(span), fc.option(span), fc.option(span))
    .map(
      ([y, m, w, d]) =>
        `P${component(y, 'Y')}${component(m, 'M')}${component(w, 'W')}${component(d, 'D')}`,
    ),
);

const throws = (run: () => unknown): boolean => {
  try {
    run();
    return false;
  } catch (error) {
    if (error instanceof Error) return true;
    throw error;
  }
};

const addPeriodFails = (value: string): boolean =>
  throws(() => addPeriod(new Date(0), value));

describe('addPeriod properties', () => {
  test('P{n}D adds exactly n days of milliseconds', () => {
    fc.assert(
      fc.property(utcDate, span, (date, n) => {
        const result = addPeriod(date, `P${String(n)}D`);
        expect(result.getTime() - date.getTime()).toBe(n * DAY_MS);
      }),
    );
  });

  test('P{n}W equals P{7n}D', () => {
    fc.assert(
      fc.property(utcDate, span, (date, n) => {
        expect(addPeriod(date, `P${String(n)}W`)).toEqual(
          addPeriod(date, `P${String(7 * n)}D`),
        );
      }),
    );
  });

  test('P{n}M moves exactly n months and clamps the day', () => {
    fc.assert(
      fc.property(utcDate, monthSpan, (date, n) => {
        const result = addPeriod(date, `P${String(n)}M`);
        expect(monthIndex(result) - monthIndex(date)).toBe(n);
        expect(result.getUTCDate()).toBe(expectedMonthDay(date, result));
      }),
    );
  });

  test('P{n}M keeps the time of day', () => {
    fc.assert(
      fc.property(utcDate, monthSpan, (date, n) => {
        const result = addPeriod(date, `P${String(n)}M`);
        expect(result.getTime() % DAY_MS).toBe(date.getTime() % DAY_MS);
      }),
    );
  });

  test('P1Y equals P12M', () => {
    fc.assert(
      fc.property(utcDate, (date) => {
        expect(addPeriod(date, 'P1Y')).toEqual(addPeriod(date, 'P12M'));
      }),
    );
  });

  test('never mutates the input date', () => {
    fc.assert(
      fc.property(utcDate, period, (date, value) => {
        const before = date.getTime();
        if (isValidPeriod(value)) addPeriod(date, value);
        expect(date.getTime()).toBe(before);
      }),
    );
  });

  test('throws exactly when isValidPeriod rejects the period', () => {
    fc.assert(
      fc.property(period, (value) => {
        expect(addPeriodFails(value)).toBe(!isValidPeriod(value));
      }),
    );
  });
});

describe('addDays properties', () => {
  test('agrees with P{n}D and leaves the input untouched', () => {
    fc.assert(
      fc.property(utcDate, span, (date, n) => {
        const before = date.getTime();
        expect(addDays(date, n)).toEqual(addPeriod(date, `P${String(n)}D`));
        expect(date.getTime()).toBe(before);
      }),
    );
  });

  test('is undone by the negated offset', () => {
    fc.assert(
      fc.property(utcDate, span, (date, n) => {
        expect(addDays(addDays(date, n), -n)).toEqual(date);
      }),
    );
  });
});
