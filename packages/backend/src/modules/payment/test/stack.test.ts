import {
  type CreatePayment,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
  AdvanceAnchor,
  ExtendPayment,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import {
  advanceLocked,
  createOrExtend,
  isLive,
  stackAnchors,
} from '@/modules/payment/domain.js';

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

// ---- the anchor invariant the near-due pay-now guard relies on ----

const liveRow: Payment = {
  id: 'sub-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: d('2026-01-31'),
  currentPeriodEnd: d('2026-02-28'),
  nextPaymentDate: d('2026-02-28'),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const invariantParams = {
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  recurring: true,
  recurringTokenRef: 'tok',
  paidAt: d('2026-02-20'),
};

/** Records what each writer would store; only the anchor paths are wired. */
const recordingRepo = (existing: Payment | null) => {
  const written: Pick<Payment, 'currentPeriodEnd' | 'nextPaymentDate'>[] = [];
  const found = () =>
    Effect.succeed(existing === null ? Option.none() : Option.some(existing));
  const repo = {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    findActiveRecurringByExternalUser: found,
    lockById: found,
    insert: (input: CreatePayment) =>
      Effect.sync(() => {
        written.push(input);
        return { ...input, id: 'sub_new', cancelRequestedAt: null };
      }),
    extend: (_id: string, input: ExtendPayment) =>
      Effect.sync(() => {
        written.push(input);
      }),
    advanceAfterSuccess: (_id: string, anchor: AdvanceAnchor) =>
      Effect.sync(() => {
        written.push(anchor);
      }),
  } as unknown as PaymentRepo;
  return { repo, written };
};

const expectInvariant = (
  written: readonly Pick<Payment, 'currentPeriodEnd' | 'nextPaymentDate'>[],
) => {
  expect(written).toHaveLength(1);
  expect(written[0]?.nextPaymentDate.getTime()).toBe(
    written[0]?.currentPeriodEnd.getTime(),
  );
};

/**
 * The near-due pay-now guard relies on every anchor writer keeping
 * `nextPaymentDate === currentPeriodEnd`: that equality is what makes it eligible, and its
 * break is what makes the deferral one-shot. `PaymentRepo.deferCharge` is the ONLY writer
 * that breaks it, on purpose (next > end until the next successful advance).
 */
describe('anchor writers keep nextPaymentDate === currentPeriodEnd', () => {
  it('insert (periodAnchors), with and without a promo bonus and cycles', () => {
    for (const extra of [
      {},
      { promoBonus: 'P7D' },
      { cycles: 3 },
      { recurring: false },
    ]) {
      const { repo, written } = recordingRepo(null);
      Effect.runSync(createOrExtend(repo)({ ...invariantParams, ...extra }));
      expectInvariant(written);
    }
  });

  it('extend (stackAnchors on a live row), one and three cycles', () => {
    for (const cycles of [1, 3]) {
      const { repo, written } = recordingRepo(liveRow);
      Effect.runSync(createOrExtend(repo)({ ...invariantParams, cycles }));
      expectInvariant(written);
    }
  });

  it('advance after a successful renewal (advanceLocked)', () => {
    const { repo, written } = recordingRepo(liveRow);
    Effect.runSync(
      advanceLocked(repo)(liveRow.id, 'P1M', d('2026-02-28'), isLive),
    );
    expectInvariant(written);
  });

  it('stackAnchors directly, for PastDue and in-period rows', () => {
    for (const paidAt of [d('2026-02-10'), d('2026-03-10')]) {
      const anchors = stackAnchors(liveRow, 'P4W', paidAt);
      expect(anchors.nextPaymentDate).toEqual(anchors.currentPeriodEnd);
    }
  });
});
