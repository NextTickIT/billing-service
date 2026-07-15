/**
 * Billing-period arithmetic (docs/04). Adds an ISO-8601 duration to a date in UTC
 * (the canonical billing timezone). Month/year steps clamp to the last valid day
 * of the target month — Jan 31 + P1M → Feb 28 — so a next-charge date never spills
 * into the following month. Days/weeks are added after, as plain day offsets.
 */

const DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;

/** Advance `date` by whole months in place, clamping the day to the month's last. */
const addMonthsClamped = (date: Date, monthSpan: number): void => {
  const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + monthSpan;
  const year = Math.floor(target / 12);
  const month = target % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  date.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
};

/** Whether `period` is an ISO-8601 duration `addPeriod` accepts (a non-empty `P…`). */
export const isValidPeriod = (period: string): boolean =>
  DURATION.test(period) && period !== 'P';

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
