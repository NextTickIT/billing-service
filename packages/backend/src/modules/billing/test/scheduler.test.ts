import { it } from '@effect/vitest';
import { SqlError } from '@effect/sql';
import {
  type DomainEvent,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Fiber, Logger, Option, TestClock } from 'effect';
import { expect } from 'vitest';

import type { Charge } from '@/modules/charge/contracts.js';
import type {
  AdvanceAnchor,
  RetryState,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';
import {
  ForeignManualCheckout,
  makeSchedulerState,
  scheduleTick,
  type SchedulerDeps,
  type SchedulerState,
} from '@/modules/billing/scheduler.js';

interface LapseCalls {
  lapsed: Payment[];
}

const config = {
  intervalSeconds: 60,
  batchSize: 10,
  upcomingChargeNoticeDays: [],
};

/** "Now" for every tick: after every fixture's due date, so `findDue`'s rows are due. */
const NOW = new Date('2026-03-01T00:00:00Z');

const baseSub: Payment = {
  id: 'sub-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const APPROVED: W4pChargeResponse = {
  transactionStatus: 'Approved',
  createdDate: '1700000000',
};

const die = () => Effect.die('unused');

const sqlError = () => new SqlError.SqlError({ message: 'connection reset' });

/** Records manual-checkout requests and returns a fixed link (keeps makeDeps small). The
 * returned URL/window are illustrative only — the scheduler doesn't assert them (production
 * derives the window from the retry ladder ~7d; the base URL from config). */
const manualCheckoutStub =
  (calls: { manualCheckout: { sub: Payment; now: Date }[] }) =>
  (sub: Payment, now: Date) =>
    Effect.sync(() => {
      calls.manualCheckout.push({ sub, now });
      return {
        checkoutUrl: `https://bill.example/checkout/chk_${sub.id}`,
        windowExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        cycleOptions: [1],
      };
    });

interface RepoCalls {
  advanced: { id: string; anchor: AdvanceAnchor } | null;
  advances: { id: string; anchor: AdvanceAnchor }[];
  retry: { id: string; state: RetryState } | null;
  renewalFailed: boolean;
}

/**
 * The PaymentRepo mock over a mutable row table: `findDue` hands back the snapshot rows,
 * `lockById` reads the CURRENT row (so a test can move it between phases, as a concurrent
 * prolongation would), and the writes the scheduler drives update the row and record into
 * `calls`. Everything else `die`s (unused on the charge path).
 */
const makeSubsMock = (
  rows: Map<string, Payment>,
  due: readonly Payment[],
  calls: RepoCalls,
): PaymentRepo => ({
  findDue: () => Effect.succeed(due),
  findUpcomingForNotice: () => Effect.succeed([]),
  lockById: (id) => Effect.sync(() => Option.fromNullable(rows.get(id))),
  advanceAfterSuccess: (id, anchor) =>
    Effect.sync(() => {
      calls.advanced = { id, anchor };
      calls.advances.push({ id, anchor });
      const row = rows.get(id);
      if (row !== undefined) {
        rows.set(id, {
          ...row,
          ...anchor,
          status: PaymentStatus.Active,
          retryAttempt: 0,
          firstFailureAt: null,
        });
      }
    }),
  recordRetry: (id, state) =>
    Effect.sync(() => {
      calls.retry = { id, state };
    }),
  markRenewalFailed: () =>
    Effect.sync(() => {
      calls.renewalFailed = true;
    }),
  findActiveRecurringByExternalUser: die,
  transaction: (effect) => effect,
  findById: die,
  insert: die,
  extend: die,
  findByExternalUser: die,
  findByContactName: die,
  listAll: die,
  requestCancel: die,
  clearCancelRequest: die,
  markCancelledLapsed: die,
  cancelUpstream: die,
  defer: die,
  updateToken: die,
  setMethod: die,
  clearToken: die,
  setEmail: () => Effect.succeed(0),
  renameExternalUser: die,
});

interface LedgerCalls {
  advanced: { id: string; anchor: AdvanceAnchor } | null;
  advances: { id: string; anchor: AdvanceAnchor }[];
  claims: Map<string, boolean>;
}

/** Undo what a failed tx 2 wrote: the rows and the advances it recorded. */
const rollback = (
  rows: Map<string, Payment>,
  snapshot: Map<string, Payment>,
  calls: LedgerCalls,
  advanceCount: number,
) => {
  rows.clear();
  snapshot.forEach((row, id) => rows.set(id, row));
  calls.advances.length = advanceCount;
  calls.advanced = calls.advances.at(-1) ?? null;
};

/**
 * The idempotency ledger, faked with a real transaction's semantics: a claimed key
 * replays its stored result without running; a failed run rolls back the rows and the
 * advance it recorded, and leaves no claim.
 */
const fakeLedger =
  (
    rows: Map<string, Payment>,
    calls: LedgerCalls,
  ): SchedulerDeps['claimAdvance'] =>
  (orderReference) =>
  (effect) =>
    Effect.suspend(() => {
      const prior = calls.claims.get(orderReference);
      if (prior !== undefined) {
        return Effect.succeed(prior);
      }
      const snapshot = new Map(rows);
      const advanceCount = calls.advances.length;
      return effect.pipe(
        Effect.tap((result) => {
          calls.claims.set(orderReference, result);
        }),
        Effect.tapError(() =>
          Effect.sync(() => {
            rollback(rows, snapshot, calls, advanceCount);
          }),
        ),
      );
    });

/** A prolongation landing: the row is paid through `end`. */
const prolongTo = (rows: Map<string, Payment>, sub: Payment, end: string) =>
  rows.set(sub.id, {
    ...sub,
    currentPeriodEnd: new Date(end),
    nextPaymentDate: new Date(end),
  });

interface DepsOptions {
  readonly response?: W4pChargeResponse;
  readonly upstreamCancelled?: boolean;
  /** Runs inside the charge HTTP call, before it answers: the phase-2 window in which a
   * prolongation can commit while the scheduler holds no lock. */
  readonly duringCharge?: (rows: Map<string, Payment>) => void;
  /** How many ingest calls fail with a SqlError before one succeeds. */
  readonly ingestFailures?: number;
  /** Extra due rows beside `sub`. */
  readonly others?: readonly Payment[];
}

const makeDeps = (sub: Payment, options: DepsOptions = {}) => {
  const lapseCalls: LapseCalls = { lapsed: [] };
  const due = [sub, ...(options.others ?? [])];
  const rows = new Map(due.map((row) => [row.id, row]));
  const calls = {
    advanced: null as { id: string; anchor: AdvanceAnchor } | null,
    advances: [] as { id: string; anchor: AdvanceAnchor }[],
    retry: null as { id: string; state: RetryState } | null,
    renewalFailed: false,
    ingested: [] as Charge[],
    ingestAttempts: 0,
    published: [] as DomainEvent[],
    manualCheckout: [] as { sub: Payment; now: Date }[],
    charged: [] as { orderReference: string; amount: number }[],
    cancelledUpstream: [] as Payment[],
    claims: new Map<string, boolean>(),
  };
  let failuresLeft = options.ingestFailures ?? 0;
  const subs = makeSubsMock(rows, due, calls);
  const deps: SchedulerDeps = {
    subs,
    client: {
      charge: (request) =>
        Effect.sync(() => {
          calls.charged.push({
            orderReference: request.orderReference,
            amount: request.amount,
          });
          options.duringCharge?.(rows);
          return options.response ?? APPROVED;
        }),
    },
    ingest: (event) =>
      Effect.suspend(() => {
        calls.ingestAttempts += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Effect.fail(sqlError());
        }
        calls.ingested.push(event);
        return Effect.void;
      }),
    publish: (event) =>
      Effect.sync(() => {
        calls.published.push(event);
      }),
    lapse: (payment) =>
      Effect.sync(() => {
        lapseCalls.lapsed.push(payment);
      }),
    upstreamCancelled: () => Effect.succeed(options.upstreamCancelled ?? false),
    cancelUpstream: (payment) =>
      Effect.sync(() => {
        calls.cancelledUpstream.push(payment);
      }),
    createManualCheckout: manualCheckoutStub(calls),
    claimAdvance: fakeLedger(rows, calls),
  };
  return { deps, calls, lapseCalls, rows };
};

/** One tick at `at` (default NOW). Forked, and the test clock run forward, so the bounded
 * tx 2 retry's backoff elapses instead of hanging the test. */
const tick = (
  deps: SchedulerDeps,
  state: SchedulerState = makeSchedulerState(),
  at: Date = NOW,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at.getTime());
    const fiber = yield* Effect.fork(scheduleTick(deps, config, state));
    yield* TestClock.adjust('1 minute');
    return yield* Fiber.join(fiber);
  });

const textOf = (message: unknown): string =>
  Array.isArray(message) ? message.join(' ') : String(message);

/** Run `effect` with every log message captured into `logs`. */
const capturingLogs = <A, E>(
  logs: string[],
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  const logger = Logger.make(({ message }) => {
    logs.push(textOf(message));
  });
  return effect.pipe(
    Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
  );
};

const countOf = (logs: readonly string[], text: string): number =>
  logs.filter((line) => line.includes(text)).length;

it.effect(
  'a contact cancelled upstream is cancelled locally and never charged',
  () =>
    Effect.gen(function* () {
      const { deps, calls, lapseCalls } = makeDeps(baseSub, {
        upstreamCancelled: true,
      });

      yield* tick(deps);

      expect(calls.cancelledUpstream.map((s) => s.id)).toEqual(['sub-1']);
      expect(calls.charged).toHaveLength(0);
      expect(calls.advanced).toBeNull();
      expect(calls.retry).toBeNull();
      expect(calls.renewalFailed).toBe(false);
      expect(lapseCalls.lapsed).toHaveLength(0);
    }),
);

it.effect(
  'an approved charge advances the subscription and records the payment',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub);

      yield* tick(deps);

      expect(calls.advanced?.id).toBe('sub-1');
      expect(
        calls.advanced?.anchor.nextPaymentDate.toISOString().slice(0, 10),
      ).toBe('2026-03-01');
      expect(calls.ingested).toHaveLength(1);
      expect(calls.published).toHaveLength(0);
      expect([...calls.claims.keys()]).toEqual([
        `sub_sub-1_${baseSub.nextPaymentDate.getTime().toString()}`,
      ]);
    }),
);

it.effect(
  'an approved charge is ingested with what the advance credited: window, next date, metadata',
  () =>
    Effect.gen(function* () {
      const sub: Payment = { ...baseSub, metadata: { planCode: 'half_year' } };
      const { deps, calls } = makeDeps(sub);

      yield* tick(deps);

      // Paid on 2026-03-01 for the month that began when the last one ended (2026-02-01).
      expect(calls.ingested[0]?.settlement).toEqual({
        // The terms it was charged on: the due row's period and method.
        period: 'P1M',
        method: 0,
        periodStart: new Date('2026-02-01T00:00:00Z'),
        periodEnd: new Date('2026-03-01T00:00:00Z'),
        nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
        metadata: { planCode: 'half_year' },
      });
    }),
);

it.effect(
  'an approved charge whose row vanished before the advance is ingested with no snapshot',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        duringCharge: (rows) => {
          rows.delete('sub-1');
        },
      });

      yield* tick(deps);

      expect(calls.ingested).toHaveLength(1);
      expect(calls.ingested[0]).not.toHaveProperty('settlement');
    }),
);

it.effect(
  'AC 4: stored renewal terms 5000/P4W charge 5000 and advance by P4W',
  () =>
    Effect.gen(function* () {
      const sub: Payment = { ...baseSub, amount: 5000, period: 'P4W' };
      const { deps, calls } = makeDeps(sub);

      yield* tick(deps);

      expect(calls.charged.map((c) => c.amount)).toEqual([5000]);
      // 2026-02-01 + 28 days.
      expect(calls.advanced?.anchor.currentPeriodEnd.toISOString()).toBe(
        '2026-03-01T00:00:00.000Z',
      );
    }),
);

it.effect(
  'a declined charge schedules the first retry (charge_retry_failed)',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        response: {
          transactionStatus: 'Declined',
          reason: 'Insufficient funds',
        },
      });

      yield* tick(deps);

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
      response: { transactionStatus: 'Declined', reason: 'gone' },
    });

    yield* tick(deps);

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
      const { deps, calls } = makeDeps(sub);

      yield* tick(deps);

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
      const { deps, calls } = makeDeps(sub);

      yield* tick(deps);

      // Advances from the anchor (2026-02-15) → 2026-03-15
      expect(
        calls.advanced?.anchor.nextPaymentDate.toISOString().slice(0, 10),
      ).toBe('2026-03-15');
    }),
);

it.effect('a cancel-pending payment lapses instead of being charged', () =>
  Effect.gen(function* () {
    const sub: Payment = {
      ...baseSub,
      cancelRequestedAt: new Date('2026-01-20T00:00:00Z'),
      metadata: null,
    };
    const { deps, calls, lapseCalls } = makeDeps(sub);

    yield* tick(deps);

    expect(lapseCalls.lapsed).toHaveLength(1);
    expect(lapseCalls.lapsed[0]?.id).toBe('sub-1');
    // No charge was attempted and no payment was advanced or published
    expect(calls.charged).toHaveLength(0);
    expect(calls.advanced).toBeNull();
    expect(calls.ingested).toHaveLength(0);
    expect(calls.published).toHaveLength(0);
  }),
);

it.effect('a normal due payment is charged (lapse branch not taken)', () =>
  Effect.gen(function* () {
    // baseSub has cancelRequestedAt: null — normal path
    const { deps, calls, lapseCalls } = makeDeps(baseSub);

    yield* tick(deps);

    expect(lapseCalls.lapsed).toHaveLength(0);
    expect(calls.advanced?.id).toBe('sub-1');
    expect(calls.ingested).toHaveLength(1);
  }),
);

it.effect(
  'a token-less (crypto) due payment prompts manual pay instead of charging',
  () =>
    Effect.gen(function* () {
      const sub: Payment = { ...baseSub, recurringTokenRef: null };
      const { deps, calls } = makeDeps(sub);
      // A token-less payment must NEVER hit the gateway charge.
      const guarded: SchedulerDeps = {
        ...deps,
        client: {
          charge: () =>
            Effect.die('charge must not run for a token-less payment'),
        },
      };

      yield* tick(guarded);

      // Our internal checkout link was minted and a manual-pay prompt was emitted.
      expect(calls.manualCheckout).toHaveLength(1);
      expect(calls.published).toHaveLength(1);
      expect(calls.published[0]?.name).toBe('payment_manual_required');
      expect(
        (calls.published[0]?.payload as { checkoutUrl?: unknown }).checkoutUrl,
      ).toContain('/checkout/');
      // It rides the SAME retry ladder — first prompt schedules the next attempt, and
      // the event says which prompt this is, so a flow can word the last one
      // differently from the first. Matches the number recordRetry stores.
      expect(
        (calls.published[0]?.payload as { attempt?: unknown }).attempt,
      ).toBe(1);
      expect(calls.retry?.state.retryAttempt).toBe(1);
      // And when the next reminder comes: the very date recordRetry just wrote.
      expect(
        (calls.published[0]?.payload as { nextRetryDate?: unknown })
          .nextRetryDate,
      ).toBe(calls.retry?.state.nextPaymentDate.toISOString());
      // No autocharge / advance happened.
      expect(calls.ingested).toHaveLength(0);
      expect(calls.advanced).toBeNull();
    }),
);

it.effect(
  'a token-less payment past the last attempt emits renewal_failed (no prompt)',
  () =>
    Effect.gen(function* () {
      const sub: Payment = {
        ...baseSub,
        recurringTokenRef: null,
        status: PaymentStatus.PastDue,
        retryAttempt: 4,
        firstFailureAt: new Date('2026-02-01T00:00:00Z'),
      };
      const { deps, calls } = makeDeps(sub);

      yield* tick(deps);

      expect(calls.renewalFailed).toBe(true);
      expect(calls.published[0]?.name).toBe('renewal_failed');
      // The giving-up tick must not mint a link or prompt again.
      expect(calls.manualCheckout).toHaveLength(0);
    }),
);

it.effect(
  'a manual prompt is not recorded when a prolongation moved the row meanwhile',
  () =>
    Effect.gen(function* () {
      const sub: Payment = { ...baseSub, recurringTokenRef: null };
      const { deps, calls, rows } = makeDeps(sub);
      const moving: SchedulerDeps = {
        ...deps,
        // The link mint is the phase-2 window for a token-less renewal.
        createManualCheckout: (s, now) =>
          deps.createManualCheckout(s, now).pipe(
            Effect.tap(() => {
              prolongTo(rows, sub, '2026-03-01T00:00:00Z');
            }),
          ),
      };

      yield* tick(moving);

      expect(calls.manualCheckout).toHaveLength(1);
      expect(calls.published).toHaveLength(0);
      expect(calls.retry).toBeNull();
    }),
);

// ── T19: lock scope, attempt claims and the decline guard ───────────────────────────

it.effect(
  'the pre-charge lock finds the payment no longer due: no charge at all',
  () =>
    Effect.gen(function* () {
      const { deps, calls, rows } = makeDeps(baseSub);
      // A prolongation committed after findDue's snapshot: the locked row is paid ahead.
      rows.set(baseSub.id, {
        ...baseSub,
        currentPeriodEnd: new Date('2026-04-01T00:00:00Z'),
        nextPaymentDate: new Date('2026-04-01T00:00:00Z'),
      });

      yield* tick(deps);

      expect(calls.charged).toHaveLength(0);
      expect(calls.advanced).toBeNull();
      expect(calls.retry).toBeNull();
    }),
);

it.effect(
  'the pre-charge lock sees a changed cancel state: no charge, no lapse',
  () =>
    Effect.gen(function* () {
      const { deps, calls, lapseCalls, rows } = makeDeps(baseSub);
      rows.set(baseSub.id, {
        ...baseSub,
        cancelRequestedAt: new Date('2026-02-20T00:00:00Z'),
      });

      yield* tick(deps);

      expect(calls.charged).toHaveLength(0);
      expect(lapseCalls.lapsed).toHaveLength(0);
    }),
);

it.effect(
  'the charge uses the locked terms and token, not the findDue snapshot',
  () =>
    Effect.gen(function* () {
      const { deps, calls, rows } = makeDeps(baseSub);
      // Same due date, but a prolongation adopted new terms after the snapshot.
      rows.set(baseSub.id, { ...baseSub, amount: 5000, period: 'P4W' });

      yield* tick(deps);

      expect(calls.charged.map((c) => c.amount)).toEqual([5000]);
      expect(calls.advanced?.anchor.currentPeriodEnd.toISOString()).toBe(
        '2026-03-01T00:00:00.000Z',
      );
    }),
);

it.effect(
  'two Approved results for the same orderReference advance once (ledger replay)',
  () =>
    Effect.gen(function* () {
      const { deps, calls, rows } = makeDeps(baseSub);

      yield* tick(deps);
      // A duplicate attempt from the same snapshot: the row is put back as it was, so
      // the second tick charges the SAME orderReference again.
      rows.set(baseSub.id, baseSub);
      yield* tick(deps);

      expect(calls.charged.map((c) => c.orderReference)).toEqual([
        calls.charged[0]?.orderReference,
        calls.charged[0]?.orderReference,
      ]);
      expect(calls.advances).toHaveLength(1);
      expect(calls.ingested).toHaveLength(1);
    }),
);

it.effect('two different orderReferences advance twice', () =>
  Effect.gen(function* () {
    const { deps, calls } = makeDeps(baseSub);

    yield* tick(deps);
    // The next cycle: the row now falls due on 2026-03-01, a new orderReference.
    yield* tick(deps, makeSchedulerState(), new Date('2026-03-02T00:00:00Z'));

    expect(new Set(calls.charged.map((c) => c.orderReference)).size).toBe(2);
    expect(calls.advances).toHaveLength(2);
    expect(calls.advances[1]?.anchor.currentPeriodEnd.toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
  }),
);

it.effect(
  'a prolongation committed during the charge is stacked on, not overwritten',
  () =>
    Effect.gen(function* () {
      const prolongedEnd = new Date('2026-03-01T00:00:00Z');
      const { deps, calls } = makeDeps(baseSub, {
        duringCharge: (rows) =>
          rows.set(baseSub.id, {
            ...baseSub,
            currentPeriodEnd: prolongedEnd,
            nextPaymentDate: prolongedEnd,
          }),
      });

      yield* tick(deps);

      // tx 2 re-reads under the lock: the charged P1M lands on top of the prolonged end.
      expect(calls.advanced?.anchor.currentPeriodEnd.toISOString()).toBe(
        '2026-04-01T00:00:00.000Z',
      );
      expect(calls.ingested).toHaveLength(1);
    }),
);

it.effect(
  'a decline is recorded when the locked due date is equal-valued (a distinct Date)',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        response: { transactionStatus: 'Declined', reason: 'no funds' },
        duringCharge: (rows) =>
          rows.set(baseSub.id, {
            ...baseSub,
            nextPaymentDate: new Date(baseSub.nextPaymentDate.getTime()),
            currentPeriodEnd: new Date(baseSub.currentPeriodEnd.getTime()),
          }),
      });

      yield* tick(deps);

      expect(calls.retry?.state.retryAttempt).toBe(1);
      expect(calls.published.map((e) => e.name)).toEqual([
        'charge_retry_failed',
      ]);
    }),
);

it.effect(
  'a decline is skipped, event and all, when a prolongation moved the row meanwhile',
  () =>
    Effect.gen(function* () {
      const { deps, calls } = makeDeps(baseSub, {
        response: { transactionStatus: 'Declined', reason: 'no funds' },
        duringCharge: (rows) =>
          rows.set(baseSub.id, {
            ...baseSub,
            currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
            nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          }),
      });

      yield* tick(deps);

      expect(calls.retry).toBeNull();
      expect(calls.renewalFailed).toBe(false);
      expect(calls.published).toHaveLength(0);
    }),
);

// ── X12 / N5: tx 2 retry, the anomaly alert and the in-process skip set ─────────────

it.effect(
  'X12: a failed ingest in tx 2 rolls back and the bounded retry records it once',
  () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const { deps, calls } = makeDeps(baseSub, { ingestFailures: 1 });

      yield* capturingLogs(logs, tick(deps));

      expect(calls.ingestAttempts).toBe(2);
      expect(calls.advances).toHaveLength(1);
      expect(calls.ingested).toHaveLength(1);
      expect(calls.claims.size).toBe(1);
      expect(countOf(logs, 'SETTLEMENT_ANOMALY')).toBe(0);
    }),
);

it.effect(
  'N5: retries exhausted → SETTLEMENT_ANOMALY, no advance, and the sub is never re-charged until restart',
  () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const other: Payment = {
        ...baseSub,
        id: 'sub-2',
        externalUserId: 'sp:2',
      };
      const { deps, calls } = makeDeps(baseSub, {
        ingestFailures: 1000,
        others: [other],
      });
      const state = makeSchedulerState();

      yield* capturingLogs(logs, tick(deps, state));

      // One try plus three retries for each due sub, all rolled back.
      expect([
        calls.ingestAttempts,
        calls.advances.length,
        calls.claims.size,
      ]).toEqual([8, 0, 0]);
      expect(
        countOf(
          logs,
          'SETTLEMENT_ANOMALY scheduler: approved charge not recorded',
        ),
      ).toBe(2);
      expect(state.unrecorded).toEqual(new Set(['sub-1', 'sub-2']));
      expect(calls.charged).toHaveLength(2);

      // The next tick in the same process charges neither again.
      yield* capturingLogs(logs, tick(deps, state));
      expect(calls.charged).toHaveLength(2);
      expect(
        countOf(logs, 'scheduler: skipped, unrecorded approved charge pending'),
      ).toBe(2);

      // A restart starts with an empty set: one retry, which alerts again if it fails.
      yield* capturingLogs(logs, tick(deps, makeSchedulerState()));
      expect(calls.charged).toHaveLength(4);
    }),
);

it.effect(
  'N5: the skip set holds only the failed sub; others still charge',
  () =>
    Effect.gen(function* () {
      const other: Payment = {
        ...baseSub,
        id: 'sub-2',
        externalUserId: 'sp:2',
      };
      const { deps, calls } = makeDeps(baseSub, { others: [other] });
      const state = makeSchedulerState();
      state.unrecorded.add('sub-1');

      yield* tick(deps, state);

      expect(calls.charged.map((c) => c.orderReference)).toEqual([
        `sub_sub-2_${baseSub.nextPaymentDate.getTime().toString()}`,
      ]);
      expect(calls.advances.map((a) => a.id)).toEqual(['sub-2']);
    }),
);

it.effect(
  'a manual link that must not be sent withholds the prompt but still advances the ladder',
  () =>
    Effect.gen(function* () {
      const sub: Payment = { ...baseSub, recurringTokenRef: null };
      const { deps, calls } = makeDeps(sub);
      const foreign: SchedulerDeps = {
        ...deps,
        createManualCheckout: (s) =>
          Effect.fail(
            new ForeignManualCheckout({
              paymentId: s.id,
              idempotencyKey: 'manual:sub-1:0',
            }),
          ),
      };

      yield* tick(foreign);

      expect(calls.published).toHaveLength(0);
      expect(calls.retry?.state.retryAttempt).toBe(1);
    }),
);

it.effect('a later manual prompt carries its own attempt number', () =>
  Effect.gen(function* () {
    // Second time around the ladder: the customer ignored prompt 1. Without the attempt
    // number every prompt is byte-identical to the flow, so it cannot escalate and the
    // customer sees the same message again with no sign the window is closing.
    const sub: Payment = {
      ...baseSub,
      recurringTokenRef: null,
      retryAttempt: 1,
      firstFailureAt: new Date('2026-01-01T00:00:00Z'),
    };
    const { deps, calls } = makeDeps(sub);

    yield* tick(deps);

    expect(calls.published[0]?.name).toBe('payment_manual_required');
    expect((calls.published[0]?.payload as { attempt?: unknown }).attempt).toBe(
      2,
    );
    expect(calls.retry?.state.retryAttempt).toBe(2);
    // Day 3 of the 0/1/3/5/7 ladder, anchored on the first failure.
    expect(
      (calls.published[0]?.payload as { nextRetryDate?: unknown })
        .nextRetryDate,
    ).toBe('2026-01-04T00:00:00.000Z');
  }),
);
