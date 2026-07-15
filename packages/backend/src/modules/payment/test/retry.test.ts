import { describe, expect, test } from 'vitest';

import { planRetry } from '@/modules/payment/retry.js';

const firstFailure = new Date('2026-01-01T00:00:00Z');
const day = (n: number): Date =>
  new Date(firstFailure.getTime() + n * 24 * 60 * 60 * 1000);

describe('planRetry (FR-005: days 0/1/3/5/7 from first failure)', () => {
  test('the first failure schedules the day-1 retry', () => {
    const plan = planRetry(0, firstFailure);
    expect(plan).toEqual({ final: false, attempt: 1, nextChargeDate: day(1) });
  });

  test('subsequent failures walk 3, 5, 7', () => {
    expect(planRetry(1, firstFailure).nextChargeDate).toEqual(day(3));
    expect(planRetry(2, firstFailure).nextChargeDate).toEqual(day(5));
    expect(planRetry(3, firstFailure).nextChargeDate).toEqual(day(7));
  });

  test('the day-7 failure is final (renewal_failed)', () => {
    const plan = planRetry(4, firstFailure);
    expect(plan.final).toBe(true);
    expect(plan.nextChargeDate).toBeNull();
  });
});
