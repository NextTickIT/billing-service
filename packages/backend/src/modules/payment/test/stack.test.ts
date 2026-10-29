import { expect, it } from 'vitest';

import { stackAnchors } from '@/modules/payment/domain.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

it('an Active row inside its period stacks on its end and keeps its start', () => {
  const row = {
    currentPeriodStart: d('2025-11-11'),
    currentPeriodEnd: d('2025-12-09'),
  };

  expect(stackAnchors(row, 'P4W', d('2025-11-18'))).toEqual({
    currentPeriodStart: d('2025-11-11'),
    currentPeriodEnd: d('2026-01-06'),
    nextPaymentDate: d('2026-01-06'),
  });
  expect(stackAnchors(row, 'P8W', d('2025-11-18')).currentPeriodEnd).toEqual(
    d('2026-02-03'),
  );
});

it('a PastDue row starts the new period at its old end, not at paidAt', () => {
  const row = {
    currentPeriodStart: d('2026-09-03'),
    currentPeriodEnd: d('2026-10-01'),
  };

  expect(stackAnchors(row, 'P4W', d('2026-10-14'))).toEqual({
    currentPeriodStart: d('2026-10-01'),
    currentPeriodEnd: d('2026-10-29'),
    nextPaymentDate: d('2026-10-29'),
  });
});

it('a month stacked on Jan 31 clamps to Feb 28', () => {
  const row = {
    currentPeriodStart: d('2025-12-31'),
    currentPeriodEnd: d('2026-01-31'),
  };

  expect(stackAnchors(row, 'P1M', d('2026-01-15')).currentPeriodEnd).toEqual(
    d('2026-02-28'),
  );
});

it('an end equal to paidAt as a distinct Date instance counts as reached', () => {
  const row = {
    currentPeriodStart: d('2026-01-01'),
    currentPeriodEnd: d('2026-02-01'),
  };

  // Same instant, different object: compared by getTime(), so the start moves to the end.
  const anchors = stackAnchors(row, 'P1M', d('2026-02-01'));

  expect(anchors.currentPeriodStart).toEqual(d('2026-02-01'));
  expect(anchors.currentPeriodEnd).toEqual(d('2026-03-01'));
});

it('three monthly cycles paid a day before the end stack to the end plus three months', () => {
  const row = {
    currentPeriodStart: d('2025-11-09'),
    currentPeriodEnd: d('2025-12-09'),
  };

  expect(stackAnchors(row, 'P1M', d('2025-12-08'), 3)).toEqual({
    currentPeriodStart: d('2025-11-09'),
    currentPeriodEnd: d('2026-03-09'),
    nextPaymentDate: d('2026-03-09'),
  });
});
