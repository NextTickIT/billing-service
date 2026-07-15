import { it } from '@effect/vitest';
import {
  type DomainEvent,
  type Subscription,
  SubscriptionStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import type {
  RetryState,
  SubscriptionRepo,
} from '@/modules/subscription/data-access.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';
import {
  scheduleTick,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';

const config = { intervalSeconds: 60, batchSize: 10 };

const baseSub: Subscription = {
  id: 'sub-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: SubscriptionStatus.Active,
  nextChargeDate: new Date('2026-02-01T00:00:00Z'),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const die = () => Effect.die('unused');

const makeDeps = (sub: Subscription, response: W4pChargeResponse) => {
  const calls = {
    advanced: null as { id: string; next: Date } | null,
    retry: null as { id: string; state: RetryState } | null,
    renewalFailed: false,
    ingested: [] as IncomingPaymentEvent[],
    published: [] as DomainEvent[],
  };
  const subs: SubscriptionRepo = {
    findDue: () => Effect.succeed([sub]),
    advanceAfterSuccess: (id, next) =>
      Effect.sync(() => {
        calls.advanced = { id, next };
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
      expect(calls.advanced?.next.toISOString().slice(0, 10)).toBe(
        '2026-03-01',
      );
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
    const sub: Subscription = {
      ...baseSub,
      status: SubscriptionStatus.PastDue,
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
 * AC-8 "before" pin: documents the CURRENT (buggy) retry-success drift.
 *
 * The subscription was due on 2026-02-01 (the anchor). It failed and a retry is
 * scheduled for 2026-02-08 (7 days later). When the retry succeeds, the current
 * code calls `advanceAfterSuccess(id, addPeriod(sub.nextChargeDate, period))` —
 * `nextChargeDate` is the retry date 2026-02-08, so the next charge is set to
 * 2026-03-08, gifting the user 7 extra days.
 *
 * Phase 4 will flip this test: the correct behaviour anchors on
 * `currentPeriodEnd` (2026-02-01), so the next charge must be 2026-03-01.
 */
it.effect(
  'AC-8 BEFORE: retry-success advances from retry date, not anchor (current drift)',
  () =>
    Effect.gen(function* () {
      // Subscription was originally due 2026-02-01 (the anchor).
      // It failed; nextChargeDate was moved to the day-7 retry: 2026-02-08.
      const sub: Subscription = {
        ...baseSub,
        status: SubscriptionStatus.PastDue,
        nextChargeDate: new Date('2026-02-08T00:00:00Z'),
        firstFailureAt: new Date('2026-02-01T00:00:00Z'),
        retryAttempt: 4, // last retry attempt (day 7)
      };
      const { deps, calls } = makeDeps(sub, {
        transactionStatus: 'Approved',
        createdDate: '1700000000',
      });

      yield* scheduleTick(deps, config);

      // BUG: advances from the retry date (2026-02-08) → 2026-03-08 (7 days gifted).
      // Phase 4 fix: must advance from anchor (2026-02-01) → 2026-03-01 instead.
      expect(calls.advanced?.next.toISOString().slice(0, 10)).toBe('2026-03-08');
    }),
);
