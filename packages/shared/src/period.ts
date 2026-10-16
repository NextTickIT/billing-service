import { Schema } from 'effect';

/**
 * The ISO-8601 duration subset billing understands: years, months, weeks, days, in that
 * order, whole numbers only. One definition shared by the wire schemas, the display
 * formatter and the backend's `addPeriod`, so "valid" can never mean two things.
 */
export const DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;

/** Whether `period` is an ISO-8601 duration `addPeriod` accepts (a non-empty `P…`).
 * Deliberately accepts the zero-length `P0D` a one-time checkout stores. */
export const isValidPeriod = (period: string): boolean =>
  DURATION.test(period) && period !== 'P';

/**
 * A valid duration that actually moves a date: at least one non-zero component. A
 * recurring period of `P0D` would leave the next charge date where it is, so the
 * scheduler would charge the card again on every tick.
 */
export const isNonZeroPeriod = (period: string): boolean => {
  const match = DURATION.exec(period);
  if (match === null || period === 'P') return false;
  // An absent component is undefined at runtime, and Number(undefined) is NaN, not > 0.
  return match.slice(1).some((part) => Number(part) > 0);
};

export const IsoPeriod = Schema.String.pipe(
  Schema.filter(isValidPeriod, {
    message: () => 'must be an ISO-8601 duration (e.g. P1M, P4W)',
  }),
);

/** A renewal cadence: a valid ISO-8601 duration that is not zero-length. */
export const RecurringPeriod = IsoPeriod.pipe(
  Schema.filter(isNonZeroPeriod, {
    message: () => 'must be a non-zero ISO-8601 duration',
  }),
);
