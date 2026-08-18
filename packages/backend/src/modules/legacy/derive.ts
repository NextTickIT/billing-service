import { Currency, PaymentStatus } from '@billing-service/shared';

import type { Charge } from '@/modules/charge/contracts.js';
import { addPeriod } from '@/modules/payment/period.js';

/**
 * Infer an external Payment's `status`, `period`, and money from its SendPulse
 * payment stream (docs/25 §3.4), reusing analytics' status rules. Pure — the import
 * injects `now` so nothing here reads the clock (docs/16 §P3). An external Payment is
 * never charged, so these fields describe history, not a live billing schedule.
 */
export interface DerivedExternal {
  readonly status: PaymentStatus;
  readonly period: string;
  readonly amount: number;
  readonly currency: number;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly nextPaymentDate: Date;
}

const DAY_MS = 86_400_000;

/** Candidate cadences; the one nearest the observed median gap wins. */
const PERIOD_BUCKETS: readonly (readonly [days: number, period: string])[] = [
  [7, 'P7D'],
  [30, 'P1M'],
  [90, 'P3M'],
  [180, 'P6M'],
  [365, 'P1Y'],
];

const last = <T>(arr: readonly T[]): T | undefined => arr[arr.length - 1];

/** Day gaps between consecutive charges (assumed sorted ascending). */
const gapDays = (charges: readonly Charge[]): readonly number[] => {
  const gaps: number[] = [];
  for (let i = 1; i < charges.length; i += 1) {
    const prev = charges[i - 1];
    const cur = charges[i];
    if (prev !== undefined && cur !== undefined) {
      gaps.push(
        (cur.occurredAt.getTime() - prev.occurredAt.getTime()) / DAY_MS,
      );
    }
  }
  return gaps;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid];
  if (hi === undefined) {
    return 0;
  }
  if (sorted.length % 2 === 1) {
    return hi;
  }
  const lo = sorted[mid - 1];
  return lo === undefined ? hi : (lo + hi) / 2;
};

const periodForDays = (days: number): string => {
  let best = 'P1M';
  let bestDelta = Infinity;
  for (const [bucketDays, period] of PERIOD_BUCKETS) {
    const delta = Math.abs(days - bucketDays);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = period;
    }
  }
  return best;
};

/** Cadence from successive succeeded charges; default `P1M` when it can't be inferred. */
const derivePeriod = (succeeded: readonly Charge[]): string => {
  if (succeeded.length < 2) {
    return 'P1M';
  }
  const gaps = gapDays(succeeded);
  return gaps.length === 0 ? 'P1M' : periodForDays(median(gaps));
};

/**
 * Collapse the stream onto our lifecycle: never paid → lapsed (`RenewalFailed`); a
 * refunded/voided last event → `Cancelled`; otherwise `Active` while the last paid
 * period still covers `now`, else lapsed.
 */
const deriveStatus = (
  latest: Charge | undefined,
  latestSucceeded: Charge | undefined,
  currentPeriodEnd: Date,
  now: Date,
): PaymentStatus => {
  if (latestSucceeded === undefined) {
    return PaymentStatus.RenewalFailed;
  }
  if (latest?.status === 'refunded') {
    return PaymentStatus.Cancelled;
  }
  return currentPeriodEnd.getTime() >= now.getTime()
    ? PaymentStatus.Active
    : PaymentStatus.RenewalFailed;
};

export const deriveExternalPayment = (
  charges: readonly Charge[],
  now: Date,
): DerivedExternal => {
  const sorted = [...charges].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const succeeded = sorted.filter((c) => c.status === 'succeeded');
  const latest = last(sorted);
  const latestSucceeded = last(succeeded);
  const money = latestSucceeded ?? latest;
  const period = derivePeriod(succeeded);
  const anchor = money?.occurredAt ?? now;
  const currentPeriodEnd = addPeriod(anchor, period);
  return {
    status: deriveStatus(latest, latestSucceeded, currentPeriodEnd, now),
    period,
    amount: money?.amount ?? 0,
    currency: money?.currency ?? Currency.UAH,
    currentPeriodStart: anchor,
    currentPeriodEnd,
    nextPaymentDate: currentPeriodEnd,
  };
};

/**
 * Guard the one-active-per-user invariant: an external row must not claim the active
 * slot when the user already holds an active Payment we do not own (a managed one, or
 * a migration that already happened). Import resolves the derived status through this
 * before writing (docs/25 §4.3).
 */
export const resolveExternalStatus = (
  derived: PaymentStatus,
  conflictingActive: boolean,
): PaymentStatus =>
  derived === PaymentStatus.Active && conflictingActive
    ? PaymentStatus.Cancelled
    : derived;
