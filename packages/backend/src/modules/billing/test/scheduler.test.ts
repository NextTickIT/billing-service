import { it } from '@effect/vitest';
import {
  type DomainEvent,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { Charge } from '@/modules/charge/contracts.js';
import type {
  AdvanceAnchor,
  RetryState,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';
import {
  scheduleTick,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';

const config = { intervalSeconds: 60, batchSize: 10 };

const baseSub: Payment = {
  id: 'sub-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.Active,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const die = () => Effect.die('unused');

const makeDeps = (sub: Payment, response: W4pChargeResponse) => {
  const calls = {
    advanced: null as { id: string; anchor: AdvanceAnchor } | null,
    retry: null as { id: string; state: RetryState } | null,
    renewalFailed: false,
    ingested: [] as Charge[],
    published: [] as DomainEvent[],
  };
  const subs: PaymentRepo = {
    findDue: () => Effect.succeed([sub]),
    advanceAfterSuccess: (id, anchor) =>
      Effect.sync(() => {
        calls.advanced = { id, anchor };
      }),
    recordRetry: (id, state) =>
      Effect.sync(() => {
        calls.retry = { id, state };
      }),
    markRenewalFailed: () =>
      Effect.sync(() => {
        calls.renewalFailed = true;
      }),
    findActiveByExternalUser: die,
    findById: die,
    insert: die,
    extend: die,
    findByExternalUser: die,
    listAll: die,
    cancel: die,
  };
  const deps: SchedulerDeps = {
    subs,
    client: { charge: () => Effect.succeed(response) },
    ingest: (event) =>
      Effect.sync(() => {
        calls.ingested.push(event);
      }),
    publish: (event) =>
      Effect.sync(() => {
        calls.published.push(event);
      }),
  };
  return { deps, calls };
};

it.effect(
  'an approved charge advances the subscription and records the payment',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        transactionStatus: 'Approved',
        createdDate: '1700000000',
      });

      yield* scheduleTick(deps, config);

      expect(calls.advanced?.id).toBe('sub-1');
      expect(
        calls.advanced?.anchor.nextPaymentDate.toISOString().slice(0, 10),
      ).toBe('2026-03-01');
      expect(calls.ingested).toHaveLength(1);
      expect(calls.published).toHaveLength(0);
    }),
);

it.effect(
  'a declined charge schedules the first retry (charge_retry_failed)',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        transactionStatus: 'Declined',
        reason: 'Insufficient funds',
      });

      yield* scheduleTick(deps, config);

      expect(calls.retry?.state.retryAttempt).toBe(1);
      expect(calls.published[0]?.name).toBe('charge_retry_failed');
      expect(calls.ingested).toHaveLength(0);
    }),
);

it.effect('a declined charge on the final attempt emits renewal_failed', () =>
  Effect.gen(function* () {
    const sub: Payment = {
      ...baseSub,
      status: PaymentStatus.PastDue,
      retryAttempt: 4,
      firstFailureAt: new Date('2026-02-01T00:00:00Z'),
    };
    const { deps, calls } = makeDeps(sub, {
      transactionStatus: 'Declined',
      reason: 'gone',
    });

    yield* scheduleTick(deps, config);

    expect(calls.renewalFailed).toBe(true);
    expect(calls.published[0]?.name).toBe('renewal_failed');
  }),
);

/**
 * AC-8: a retry-success must advance from the period ANCHOR (`currentPeriodEnd`),
 * not from `nextPaymentDate` (the retry date). The payment was due 2026-02-01
 * (anchor). After a failure + 7-day retry at 2026-02-08, success must still yield
 * nextPaymentDate = 2026-03-01 (anchor + period), not 2026-03-08 (retry + period).
 */
it.effect(
  'AC-8: retry-success advances from the anchor, not the retry date',
  () =>
    Effect.gen(function* () {
      const sub: Payment = {
        ...baseSub,
        status: PaymentStatus.PastDue,
        // anchor stays at 2026-02-01 (currentPeriodEnd)
        currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
        // retry scheduled for 7 days later
        nextPaymentDate: new Date('2026-02-08T00:00:00Z'),
        firstFailureAt: new Date('2026-02-01T00:00:00Z'),
        retryAttempt: 4,
      };
      const { deps, calls } = makeDeps(sub, {
        transactionStatus: 'Approved',
        createdDate: '1700000000',
      });

      yield* scheduleTick(deps, config);

      // Must advance from anchor (2026-02-01) → 2026-03-01, NOT from retry date
      expect(
        calls.advanced?.anchor.nextPaymentDate.toISOString().slice(0, 10),
      ).toBe('2026-03-01');
      expect(
        calls.advanced?.anchor.currentPeriodStart.toISOString().slice(0, 10),
      ).toBe('2026-02-01');
      expect(
        calls.advanced?.anchor.currentPeriodEnd.toISOString().slice(0, 10),
      ).toBe('2026-03-01');
    }),
);

/**
 * F-D: a fresh checkout sets currentPeriodStart=paidAt, currentPeriodEnd=nextPaymentDate.
 */
it.effect(
  'AC-8 fresh-checkout: new payment has non-null anchors from paidAt',
  () =>
    Effect.gen(function* () {
      const sub: Payment = {
        ...baseSub,
        currentPeriodStart: new Date('2026-01-15T00:00:00Z'),
        currentPeriodEnd: new Date('2026-02-15T00:00:00Z'),
        nextPaymentDate: new Date('2026-02-15T00:00:00Z'),
      };
      const { deps, calls } = makeDeps(sub, {
        transactionStatus: 'Approved',
        createdDate: '1700000000',
      });

      yield* scheduleTick(deps, config);

      // Advances from the anchor (2026-02-15) → 2026-03-15
      expect(
        calls.advanced?.anchor.nextPaymentDate.toISOString().slice(0, 10),
      ).toBe('2026-03-15');
    }),
);
