/**
 * Billing-period arithmetic (docs/04). Adds an ISO-8601 duration to a date in UTC
 * (the canonical billing timezone). Month/year steps clamp to the last valid day
 * of the target month — Jan 31 + P1M → Feb 28 — so a next-charge date never spills
 * into the following month. Days/weeks are added after, as plain day offsets.
 */

import { DURATION, isValidPeriod } from '@billing-service/shared';

// The validator lives in shared so the wire schemas and this arithmetic agree on what a
// period is; re-exported for the callers that already import it from here.
export { isValidPeriod };

/** Advance `date` by whole months in place, clamping the day to the month's last. */
const addMonthsClamped = (date: Date, monthSpan: number): void => {
  const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + monthSpan;
  const year = Math.floor(target / 12);
  const month = target % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  date.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
};

/**
 * Add whole days to a date in UTC — used by deferral (docs/23), which pushes the
 * paid-through anchor by N days. Plain day arithmetic, no month clamping (a day
 * offset never lands on an invalid day).
 */
export const addDays = (date: Date, days: number): Date => {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

export const addPeriod = (date: Date, period: string): Date => {
  const match = DURATION.exec(period);
  if (match === null || period === 'P') {
    throw new Error(`addPeriod: unsupported ISO-8601 duration '${period}'`);
  }
  const [, years, months, weeks, days] = match;
  const result = new Date(date.getTime());

  const monthSpan = Number(years ?? 0) * 12 + Number(months ?? 0);
  if (monthSpan !== 0) {
    addMonthsClamped(result, monthSpan);
  }
  const daySpan = Number(weeks ?? 0) * 7 + Number(days ?? 0);
  if (daySpan !== 0) {
    result.setUTCDate(result.getUTCDate() + daySpan);
  }
  return result;
};

/**
 * `period` added `times` times in a row, each step clamped on its own: three P1M cycles
 * from Jan 31 land on Apr 28, exactly where three separate monthly payments would, not
 * on the Apr 30 that one P3M step gives.
 */
export const addPeriods = (date: Date, period: string, times: number): Date =>
  Array.from({ length: times }).reduce<Date>(
    (at) => addPeriod(at, period),
    date,
  );

// Fixed UTC instants whose following month and year differ in length (31 vs 28 days,
// 365 vs 366), so no day count matches a month or a year on all of them.
const PERIOD_ANCHORS = [
  new Date(Date.UTC(2001, 0, 1)),
  new Date(Date.UTC(2001, 1, 1)),
  new Date(Date.UTC(2003, 2, 1)),
];

/**
 * Whether two valid periods add the same time: 'P28D' equals 'P4W' and 'P12M' equals
 * 'P1Y', but 'P1M' never equals any day count. Compared over fixed anchors, so it is a
 * pure function of the two strings.
 */
export const samePeriod = (a: string, b: string): boolean =>
  PERIOD_ANCHORS.every(
    (anchor) =>
      addPeriod(anchor, a).getTime() === addPeriod(anchor, b).getTime(),
  );
