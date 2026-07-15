import { RETRY_SCHEDULE_DAYS } from '@billing-service/shared';

/**
 * The fixed failed-charge retry schedule (FR-005): days 0, 1, 3, 5, 7 from the
 * first failure. Day 0 is the original due charge failing; retries then fall on
 * days 1/3/5/7. The day-7 attempt failing is final — the gateway stops and the
 * external system decides the fate of access. Pure, so the ladder is exhaustively
 * unit-testable without a clock.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetryPlan {
  /** true when the schedule is exhausted (day-7 failed) → renewal_failed. */
  readonly final: boolean;
  /** The attempt number this failure represents (1 = first, at day 0). */
  readonly attempt: number;
  /** When to charge next; null when final. */
  readonly nextPaymentDate: Date | null;
}

/**
 * Plan the next step after a charge failed. `priorFailures` is the count before
 * this one (0 for the first failure); `firstFailureAt` anchors the schedule.
 */
export const planRetry = (
  priorFailures: number,
  firstFailureAt: Date,
): RetryPlan => {
  const attempt = priorFailures + 1;
  if (attempt >= RETRY_SCHEDULE_DAYS.length) {
    return { final: true, attempt, nextPaymentDate: null };
  }
  const offsetDays = RETRY_SCHEDULE_DAYS[attempt] ?? 0;
  return {
    final: false,
    attempt,
    nextPaymentDate: new Date(firstFailureAt.getTime() + offsetDays * DAY_MS),
  };
};
