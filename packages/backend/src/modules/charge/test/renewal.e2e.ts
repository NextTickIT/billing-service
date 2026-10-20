import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Either, Exit, Fiber, Option } from 'effect';

import { claimBatch, reapStale } from '@/infra/queue/store.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import migration0021 from '@/migrations/0021_checkout_renewal.js';
import {
  ledgerClaimAdvance,
  scheduleTick,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';
import {
  type Charge,
  PAYMENT_EVENT_RECEIVED,
} from '@/modules/charge/contracts.js';
import {
  makeChargeRepo,
  type ChargeRepo,
} from '@/modules/charge/data-access.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  asPayload,
  awaitLockWait,
  captureLogs,
  type Check,
  DAY,
  type EffectE2eContext,
  type EffectScenario,
  expectRows,
  failOncePublishing,
  fastForwardRetries,
  type Gate,
  holdRetries,
  HOUR,
  injectedFault,
  makeGate,
  openGate,
  P4W,
  pauseAt,
  registerHandlers,
  runFor,
  seedSub,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  manualRenewalSession,
  prolongSession,
} from '@/modules/checkout/domain.js';
import {
  claimPayableSession,
  effectivePayable,
  resolvePayableSessionId,
} from '@/modules/checkout/routes.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { lapseNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_LAPSE } from '@/modules/payment/contracts.js';
import {
  makePaymentRepo,
  type PaymentRepo,
} from '@/modules/payment/data-access.js';
import { advanceLocked, computeDeferral } from '@/modules/payment/domain.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import { lapseEnqueuer } from '@/worker-boot.js';

/**
 * Renewal / prolong / settlement e2e (plan §4: T15–T18, T22, T24, T28, T31 and T35
 * claim backstops, T33, T36–T38). Each scenario runs on its own freshly-migrated
 * Postgres. Concurrency is staged with gates held inside a real transaction, and a
 * contender is released only once Postgres itself reports it parked on the lock
 * (`awaitLockWait`) — no timing guesses.
 */

type Query = EffectE2eContext['query'];

const FAR = new Date('2030-01-01T00:00:00Z');
const TICK = {
  intervalSeconds: 60,
  batchSize: 10,
  upcomingChargeNoticeDays: [],
};
const USD = 1;
const CREATED = String(CheckoutSessionStatus.Created);
const COMPLETED = String(CheckoutSessionStatus.Completed);

interface ChargeSeed {
  readonly source?: string;
  readonly status?: Charge['status'];
  readonly amount?: number;
  readonly currency?: number;
  readonly payload?: Record<string, unknown>;
}

/** A provider callback for checkout session `ref` (30000, UAH unless told). */
const callback = (
  ref: string,
  idemKey: string,
  occurredAt: Date,
  c: ChargeSeed = {},
): Charge => ({
  source: c.source ?? 'wayforpay_callback',
  idemKey,
  externalRef: ref,
  externalUserId: null,
  amount: c.amount ?? 30000,
  currency: c.currency ?? 0,
  status: c.status ?? 'succeeded',
  occurredAt,
  payload: c.payload ?? {},
});

/** A WhitePay (crypto, USD) callback for `chk`. */
const whitepay = (chk: string, status: Charge['status']) =>
  callback(chk, `wp:${chk}|${status}`, new Date('2026-05-03T00:00:00Z'), {
    source: 'whitepay_callback',
    currency: USD,
    status,
  });

/** The row as it is now (a vanished row is a defect of the scenario). */
const current = (subs: PaymentRepo, id: string) =>
  subs.findById(id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(`payment ${id} vanished`),
        onSome: Effect.succeed,
      }),
    ),
  );

const endMs = (sub: Payment): number => sub.currentPeriodEnd.getTime();

const isLive = (p: Payment): boolean =>
  p.status === PaymentStatus.Active || p.status === PaymentStatus.PastDue;

const orderReferenceOf = (sub: Payment): string =>
  `${PAYMENT_ORDER_PREFIX}${sub.id}_${sub.nextPaymentDate.getTime().toString()}`;

/** The scheduler's own tx 2 for one approved charge: the ledger claim around the locked
 * advance, as `recordApproved` runs it. */
const schedulerAdvance = (
  sql: SqlClient.SqlClient,
  subs: PaymentRepo,
  sub: Payment,
) =>
  ledgerClaimAdvance(sql)(orderReferenceOf(sub))(
    advanceLocked(subs)(sub.id, sub.period, new Date(), isLive).pipe(
      Effect.map(Option.isSome),
    ),
  );

/** Scheduler deps on the scenario DB; anything a scenario does not expect dies loudly. */
const schedulerDeps = (overrides: Partial<SchedulerDeps> = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deps: SchedulerDeps = {
      subs: makePaymentRepo(sql),
      client: { charge: () => Effect.die('no charge expected in this tick') },
      ingest: (yield* ChargePipeline).ingest,
      publish: (yield* Outbox).publish,
      lapse: lapseEnqueuer(sql),
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.die('no upstream cancel expected'),
      claimAdvance: ledgerClaimAdvance(sql),
      createManualCheckout: () => Effect.die('no manual checkout expected'),
      ...overrides,
    };
    return deps;
  });

/** One scheduler tick on the scenario DB with `overrides`. */
const tick = (overrides: Partial<SchedulerDeps> = {}) =>
  schedulerDeps(overrides).pipe(
    Effect.flatMap((deps) => scheduleTick(deps, TICK)),
  );

const approving: SchedulerDeps['client'] = {
  charge: () =>
    Effect.succeed({
      transactionStatus: 'Approved',
      createdDate: '1700000000',
    }),
};

/** A repo whose `lockById` takes the real row lock, then parks at `gate` — and
 * optionally fails once released. */
const holdingRowLock = (
  payments: PaymentRepo,
  gate: Gate,
  failAfterRelease: boolean,
): PaymentRepo => ({
  ...payments,
  lockById: (id) =>
    payments.lockById(id).pipe(
      Effect.tap(() => pauseAt(gate)),
      Effect.tap(() =>
        failAfterRelease
          ? Effect.fail(injectedFault('after lockById'))
          : Effect.void,
      ),
    ),
});

/** A charge repo whose settlement lock (`lockMatchResult`) parks at `gate`. */
const holdingMatchLock = (repo: ChargeRepo, gate: Gate): ChargeRepo => ({
  ...repo,
  lockMatchResult: (id) =>
    repo.lockMatchResult(id).pipe(Effect.tap(() => pauseAt(gate))),
});

const ms = (d: Date): string => d.getTime().toString();

/** `currentPeriodEnd` of one payment as epoch ms (SQL side). */
const endSql = (id: string) =>
  `SELECT (extract(epoch FROM "currentPeriodEnd") * 1000)::bigint FROM payments WHERE id = '${id}'`;

const sessionStatusSql = (id: string) =>
  `SELECT status FROM checkout_sessions WHERE id = '${id}'`;

const matchResultSql = (idemKey: string) =>
  `SELECT "matchResult" FROM charges WHERE "idemKey" = '${idemKey}'`;

const countEventsSql = (name: string) =>
  `SELECT count(*) FROM domain_events WHERE name = '${name}'`;

const trimmed = (query: Query, sql: string) =>
  query(sql).then((out) => out.trim());

// ---------------------------------------------------------------------------------
// T15 — a fault inside settlement rolls everything back; the retry applies once.
// ---------------------------------------------------------------------------------

const T15_END = new Date('2026-02-01T00:00:00Z');
const T15_KEY = 'w4pcb:chk_t15|Approved';

/** Prolong a sub whose settlement publish fails once; attempt 1 parks in `retry`. */
const driveT15 = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const sub = yield* seedSub(makePaymentRepo(sql), {
    externalUserId: 'sp:t15',
    end: T15_END,
  });
  yield* makeCheckoutRepo(sql).insert(
    prolongSession(sub, 'chk_t15', FAR, null),
  );
  // The fault lands after the applier, the fixation and any earlier event.
  const handler = yield* settlementHandler({
    publish: failOncePublishing(
      (yield* Outbox).publish,
      'recurring_payment_succeeded',
    ),
  });
  yield* (yield* TaskRegistry).register(PAYMENT_EVENT_RECEIVED, handler);
  yield* (yield* ChargePipeline).ingest(
    callback('chk_t15', T15_KEY, new Date('2026-01-15T00:00:00Z'), {
      payload: { recToken: 'tok_new' },
    }),
  );
  yield* runFor(1.5, holdRetries);
  return sub.id;
});

const retryNow = Effect.gen(function* () {
  yield* fastForwardRetries(yield* SqlClient.SqlClient);
  yield* runFor(2);
});

/** Requeue the (already settled) charge message and let the dispatcher run it again. */
const redeliverCharge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE messages SET status = 'retry', "retryAt" = now(), "finishedAt" = NULL
    WHERE "messageType" = 'payment_event_received'
  `;
  yield* runFor(1.5);
});

const t15RolledBack = (subId: string): readonly Check[] => [
  [
    `SELECT status FROM messages WHERE "messageType" = 'payment_event_received'`,
    'retry',
    'attempt 1 failed and is parked for retry',
  ],
  [
    `SELECT "recurringTokenRef" || '|' || amount || '|' || period FROM payments`,
    'tok_old|30000|P4W',
    'the payment terms and token are unchanged',
  ],
  [endSql(subId), ms(T15_END), 'the payment end is unchanged'],
  [sessionStatusSql('chk_t15'), CREATED, 'the session claim rolled back'],
  [`SELECT count(*) FROM charge_fixations`, '0', 'no fixation'],
  [`SELECT count(*) FROM domain_events`, '0', 'no event'],
  [matchResultSql(T15_KEY), 'unmatched', "matchResult is not 'matched'"],
];

const t15SettledOnce = (subId: string): readonly Check[] => [
  [endSql(subId), ms(new Date(T15_END.getTime() + P4W)), 'one period stacked'],
  [`SELECT "recurringTokenRef" FROM payments`, 'tok_new', 'new token stored'],
  [`SELECT count(*) FROM charge_fixations`, '1', 'one fixation'],
  [countEventsSql('recurring_payment_succeeded'), '1', 'one success event'],
  [
    `SELECT count(*) FROM domain_events WHERE name <> 'recurring_payment_succeeded'`,
    '0',
    'no other event (no payment_created for a prolongation)',
  ],
  [sessionStatusSql('chk_t15'), COMPLETED, 'the session is completed'],
  [matchResultSql(T15_KEY), 'matched', "matchResult is 'matched'"],
  [`SELECT count(*) FROM quarantine_records`, '0', 'no quarantine'],
];

const t15FailureInjection: EffectScenario = {
  name: 'settlement (T15): a publish fault after the apply rolls the whole settlement back; the retry applies once',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const subId = await run(driveT15);
      await expectRows(query, t15RolledBack(subId));
      await run(retryNow);
      await expectRows(query, t15SettledOnce(subId));
      // A redelivery of the same message (reaper/requeue) through the dispatcher.
      await run(redeliverCharge);
      await expectRows(query, [
        [
          `SELECT count(*) FROM attempts a JOIN messages m ON m.id = a."messageId" WHERE m."messageType" = 'payment_event_received'`,
          '3',
          'the redelivery really ran (three attempts)',
        ],
        ...t15SettledOnce(subId),
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T16 / T17 — a prolong holding the row lock serialises a scheduler advance / a defer.
// ---------------------------------------------------------------------------------

const BARRIER_END = new Date('2026-03-02T00:00:00Z');

interface Race<A> {
  readonly externalUserId: string;
  readonly failProlong: boolean;
  readonly contender: (
    sql: SqlClient.SqlClient,
    sub: Payment,
  ) => Effect.Effect<A, unknown>;
  /** pg_stat_activity `query LIKE` of the contender's blocked statement. */
  readonly contenderSql: string;
}

/** Settle a prolong whose apply holds the payment row lock, start the contender while it
 * is held, prove Postgres parks it, then release both. */
const raceAgainstHeldProlong = <A>(race: Race<A>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subs = makePaymentRepo(sql);
    const sub = yield* seedSub(subs, {
      externalUserId: race.externalUserId,
      end: BARRIER_END,
    });
    const chk = `chk_${sub.id}`;
    yield* makeCheckoutRepo(sql).insert(prolongSession(sub, chk, FAR, null));
    const gate = yield* makeGate;
    const prolong = yield* settlementHandler({
      payments: holdingRowLock(subs, gate, race.failProlong),
    });
    const a = yield* Effect.fork(
      prolong(
        asPayload(
          callback(chk, `w4pcb:${chk}|Approved`, new Date('2026-02-20')),
        ),
      ),
    );
    yield* gate.reached;
    const b = yield* Effect.fork(race.contender(sql, sub));
    // pg_stat_activity + pg_locks: B is parked on A's row lock, not merely slow.
    yield* awaitLockWait(sql, race.contenderSql);
    yield* openGate(gate);
    const prolongExit = yield* Fiber.await(a);
    const result = yield* Fiber.join(b);
    return { chk, prolongExit, result, final: yield* current(subs, sub.id) };
  });

const lockedAdvance = (sql: SqlClient.SqlClient, sub: Payment) =>
  schedulerAdvance(sql, makePaymentRepo(sql), sub);

const LOCK_BY_ID_SQL = '%FROM payments WHERE id = $1 FOR UPDATE%';

const t16BarrierSchedulerAdvance: EffectScenario = {
  name: 'barrier (T16): a scheduler advance waits on a prolong holding lockById, then stacks on the moved end',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const out = await run(
        raceAgainstHeldProlong({
          externalUserId: 'sp:t16',
          failProlong: false,
          contender: lockedAdvance,
          contenderSql: LOCK_BY_ID_SQL,
        }),
      );
      assert.ok(Exit.isSuccess(out.prolongExit), 'the prolong settled');
      assert.equal(out.result, true, 'the scheduler advance applied');
      assert.equal(
        endMs(out.final),
        BARRIER_END.getTime() + 2 * P4W,
        'end = old + P4W (prolong) + P4W (renewal): serialised, nothing lost',
      );
      await expectRows(query, [
        [`SELECT count(*) FROM charge_fixations`, '1', 'prolong fixed once'],
        [
          `SELECT count(*) FROM idempotency_keys WHERE scope = 'scheduler.advance'`,
          '1',
          'the renewal claim committed with its advance',
        ],
      ]);
    }),
};

const t16BarrierRollback: EffectScenario = {
  name: 'barrier (T16): a prolong that fails after taking the lock rolls back; the advance stacks once on the old end',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const out = await run(
        raceAgainstHeldProlong({
          externalUserId: 'sp:t16r',
          failProlong: true,
          contender: lockedAdvance,
          contenderSql: LOCK_BY_ID_SQL,
        }),
      );
      assert.ok(Exit.isFailure(out.prolongExit), 'the prolong failed');
      assert.equal(out.result, true, 'the scheduler advance applied');
      assert.equal(
        endMs(out.final),
        BARRIER_END.getTime() + P4W,
        'end = old + P4W: the rolled-back prolong left nothing behind',
      );
      await expectRows(query, [
        [sessionStatusSql(out.chk), CREATED, 'the prolong is still payable'],
        [`SELECT count(*) FROM charge_fixations`, '0', 'no fixation'],
        [`SELECT count(*) FROM domain_events`, '0', 'no event'],
      ]);
    }),
};

const t17DeferRacesProlong: EffectScenario = {
  name: 'barrier (T17): a defer racing a prolong waits on the lock; both apply (old + period + N days)',
  run: ({ config }) =>
    withWorker(config, async (run) => {
      const out = await run(
        raceAgainstHeldProlong({
          externalUserId: 'sp:t17',
          failProlong: false,
          contender: (sql, sub) => makePaymentRepo(sql).defer(sub.id, 3),
          contenderSql: '%UPDATE payments%make_interval%',
        }),
      );
      assert.ok(Exit.isSuccess(out.prolongExit), 'the prolong settled');
      const expected = BARRIER_END.getTime() + P4W + 3 * DAY;
      assert.equal(endMs(out.final), expected, 'end = old + P4W + 3 days');
      assert.equal(out.final.nextPaymentDate.getTime(), expected);
      assert.equal(
        Option.getOrNull(out.result)?.getTime(),
        expected,
        'defer reports the end it actually wrote',
      );
    }),
};

// ---------------------------------------------------------------------------------
// T18 — a lapse made stale by a defer is a no-op; the lapse is atomic with its event.
// ---------------------------------------------------------------------------------

/** A cancel-pending Active sub that came due an hour ago. */
const seedDueCancelPending = (externalUserId: string) =>
  Effect.gen(function* () {
    const subs = makePaymentRepo(yield* SqlClient.SqlClient);
    const sub = yield* seedSub(subs, {
      externalUserId,
      end: new Date(Date.now() - HOUR),
    });
    assert.ok(
      Option.isSome(yield* subs.requestCancel(sub.id)),
      'cancel requested',
    );
    return sub;
  });

/** Move a row's anchors back by `millis`: the database clock cannot be advanced, so
 * "time passes" is the row's dates moving toward it instead. */
const ageRow = (id: string, millis: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secs = millis / 1000;
    yield* sql`
      UPDATE payments
      SET "currentPeriodStart" = "currentPeriodStart" - make_interval(secs => ${secs}),
          "currentPeriodEnd" = "currentPeriodEnd" - make_interval(secs => ${secs}),
          "nextPaymentDate" = "nextPaymentDate" - make_interval(secs => ${secs})
      WHERE id = ${id}
    `;
  });

/** Lapse enqueued by a tick; an operator defer moves the due date before it runs. */
const driveT18 = Effect.gen(function* () {
  yield* registerHandlers;
  const sub = yield* seedDueCancelPending('sp:t18');
  yield* tick();
  const moved = yield* makePaymentRepo(yield* SqlClient.SqlClient).defer(
    sub.id,
    3,
  );
  assert.ok(Option.isSome(moved), 'defer applied to the Active sub');
  yield* runFor(1.5);
  return sub.id;
});

/** Time reaches the deferred due date: the next tick lapses it under a new key. */
const lapseAtMovedDueDate = (subId: string) =>
  Effect.gen(function* () {
    yield* ageRow(subId, 3 * DAY + 2 * HOUR);
    yield* tick();
    yield* runFor(1.5);
  });

const t18StaleLapse: EffectScenario = {
  name: 'lapse (T18): a lapse enqueued before a defer moved the due date does nothing; the next due date lapses',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const subId = await run(driveT18);
      await expectRows(query, [
        [
          `SELECT count(*) || '|' || min(status) FROM messages WHERE "messageType" = 'payment_lapse'`,
          '1|success',
          'one lapse ran (and was a no-op)',
        ],
        [
          `SELECT status || '|' || ("cancelRequestedAt" IS NOT NULL) FROM payments`,
          `${String(PaymentStatus.Active)}|true`,
          'still Active and still cancel-pending',
        ],
        [
          `SELECT count(*) FROM domain_events WHERE name IN ('renewal_failed', 'payment_cancelled')`,
          '0',
          'no renewal_failed and no payment_cancelled',
        ],
      ]);
      await run(lapseAtMovedDueDate(subId));
      await expectRows(query, [
        [
          `SELECT count(DISTINCT "idemKey") FROM messages WHERE "messageType" = 'payment_lapse'`,
          '2',
          'the moved due date got a lapse key of its own',
        ],
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Cancelled),
          'lapsed',
        ],
        [
          `${countEventsSql('renewal_failed')} AND payload->>'reason' = 'cancelled'`,
          '1',
          'exactly one renewal_failed (cancelled)',
        ],
      ]);
    }),
};

/**
 * A lapse enqueued by a tick, then a reactivation that wins the race (the lapse runs as a
 * no-op), then a fresh cancel of the same period: same due date, new cancellation.
 */
const driveT18Recancel = Effect.gen(function* () {
  yield* registerHandlers;
  const subs = makePaymentRepo(yield* SqlClient.SqlClient);
  const sub = yield* seedDueCancelPending('sp:t18r');
  yield* tick();
  assert.ok(
    Option.isSome(yield* subs.clearCancelRequest(sub.id)),
    'reactivated',
  );
  yield* runFor(1.5);
  assert.ok(
    Option.isSome(yield* subs.requestCancel(sub.id)),
    'cancelled again',
  );
  yield* tick();
  yield* runFor(1.5);
});

const t18RecancelSamePeriod: EffectScenario = {
  name: 'lapse (T18): a cancel after a reactivation that beat the lapse gets its own lapse in the same period',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(driveT18Recancel);
      await expectRows(query, [
        [
          `SELECT count(DISTINCT "idemKey") FROM messages WHERE "messageType" = 'payment_lapse'`,
          '2',
          'the second cancellation got a lapse key of its own',
        ],
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Cancelled),
          'lapsed',
        ],
        [
          `${countEventsSql('renewal_failed')} AND payload->>'reason' = 'cancelled'`,
          '1',
          'exactly one renewal_failed (cancelled)',
        ],
      ]);
    }),
};

/** The lapse handler's publish fails once; attempt 1 parks in `retry`. */
const driveT18Fault = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const publish = failOncePublishing((yield* Outbox).publish, 'renewal_failed');
  yield* (yield* TaskRegistry).register(
    PAYMENT_LAPSE,
    lapseNotify(makePaymentRepo(sql), publish),
  );
  const sub = yield* seedDueCancelPending('sp:t18f');
  yield* tick();
  yield* runFor(1.5, holdRetries);
  return sub.id;
});

const t18LapseFailureInjection: EffectScenario = {
  name: 'lapse (T18): a publish fault inside lapseNotify rolls the cancel back; redelivery cancels once',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const subId = await run(driveT18Fault);
      await expectRows(query, [
        [
          `SELECT status FROM messages WHERE "messageType" = 'payment_lapse'`,
          'retry',
          'the lapse attempt failed',
        ],
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Active),
          'the cancel flip rolled back with the failed publish',
        ],
        [`SELECT count(*) FROM domain_events`, '0', 'no event'],
      ]);
      await run(retryNow);
      await expectRows(query, [
        [
          `SELECT status FROM payments`,
          String(PaymentStatus.Cancelled),
          'cancelled',
        ],
        [
          `SELECT count(*) || '|' || bool_and(id LIKE 'evt_${subId}_cancel_lapsed_%') FROM domain_events WHERE name = 'renewal_failed'`,
          '1|true',
          'exactly one renewal_failed, keyed on this payment and its cancellation',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T22 — no lock or open transaction across the provider call; defer across DST.
// ---------------------------------------------------------------------------------

/** A WFP client whose charge parks at `gate`, then approves. */
const gatedApproval = (gate: Gate): SchedulerDeps['client'] => ({
  charge: (input) =>
    pauseAt(gate).pipe(Effect.andThen(approving.charge(input))),
});

/** What is held while the provider call is in flight. */
const heldDuringCharge = (sql: SqlClient.SqlClient, subId: string) =>
  Effect.gen(function* () {
    const idle = yield* sql<{ readonly n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state LIKE 'idle in transaction%'
    `;
    const locks = yield* sql<{ readonly n: number }>`
      SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'payments' AND l.pid <> pg_backend_pid()
    `;
    // And the row is free to lock right now (NOWAIT fails on a held lock).
    yield* sql.withTransaction(
      sql`SELECT id FROM payments WHERE id = ${subId} FOR UPDATE NOWAIT`,
    );
    return { idle: idle[0]?.n, locks: locks[0]?.n };
  });

/** Settle a prolong of `sub` directly (not via the queue). */
const settleProlong = (sub: Payment, chk: string) =>
  Effect.gen(function* () {
    yield* makeCheckoutRepo(yield* SqlClient.SqlClient).insert(
      prolongSession(sub, chk, FAR, null),
    );
    yield* (yield* ChargePipeline).handleFromPayload(
      asPayload(callback(chk, `w4pcb:${chk}|Approved`, new Date())),
    );
  });

const driveT22 = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const sub = yield* seedSub(subs, {
    externalUserId: 'sp:t22',
    end: new Date(Date.now() - HOUR),
  });
  const gate = yield* makeGate;
  const ticking = yield* Effect.fork(tick({ client: gatedApproval(gate) }));
  yield* gate.reached;
  const held = yield* heldDuringCharge(sql, sub.id);
  // A prolong commits while the provider call is still in flight.
  yield* settleProlong(sub, 'chk_t22');
  const afterProlong = yield* current(subs, sub.id);
  yield* openGate(gate);
  yield* Fiber.join(ticking);
  yield* runFor(2);
  return { sub, held, afterProlong, final: yield* current(subs, sub.id) };
});

const t22LockScope: EffectScenario = {
  name: 'scheduler (T22): no row lock or idle transaction during client.charge; a prolong landing meanwhile is stacked on',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const out = await run(driveT22);
      assert.equal(out.held.idle, 0, 'no idle-in-transaction connection');
      assert.equal(out.held.locks, 0, 'no lock on payments during the charge');
      assert.equal(
        endMs(out.afterProlong),
        endMs(out.sub) + P4W,
        'the prolong stacked while the charge was in flight',
      );
      assert.equal(
        endMs(out.final),
        endMs(out.sub) + 2 * P4W,
        'the post-charge advance stacked on the moved end',
      );
      await expectRows(query, [
        [
          countEventsSql('recurring_payment_succeeded'),
          '2',
          'one success for the prolong, one for the renewal',
        ],
      ]);
    }),
};

const driveDeferAcrossDst = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  // 2026-10-25 is the last Sunday of October (Kyiv leaves summer time).
  const sub = yield* seedSub(subs, {
    externalUserId: 'sp:t22dst',
    end: new Date('2026-10-24T12:00:00Z'),
  });
  // In a DST session zone: `days =>` interval arithmetic would gain an hour here.
  const deferred = yield* sql.withTransaction(
    sql`SET LOCAL TIME ZONE 'Europe/Kyiv'`.pipe(
      Effect.andThen(subs.defer(sub.id, 3)),
    ),
  );
  return { sub, deferred, final: yield* current(subs, sub.id) };
});

const t22DeferAcrossDst: EffectScenario = {
  name: 'defer (T22): defer(3) across the last Sunday of October is +72h, equal to computeDeferral',
  run: ({ config }) =>
    withWorker(config, async (run) => {
      const out = await run(driveDeferAcrossDst);
      const expected = computeDeferral(out.sub, 3).newPeriodEnd.getTime();
      assert.equal(expected, endMs(out.sub) + 72 * HOUR);
      assert.equal(Option.getOrNull(out.deferred)?.getTime(), expected);
      assert.equal(endMs(out.final), expected, 'currentPeriodEnd = old + 72h');
      assert.equal(out.final.nextPaymentDate.getTime(), expected);
    }),
};

// ---------------------------------------------------------------------------------
// T24 — a reaped redelivery waits on the charges row, then returns on 'matched'.
// ---------------------------------------------------------------------------------

const takeCharge = (sql: SqlClient.SqlClient, workerId: string) =>
  claimBatch(sql)({ workerId, limit: 1, types: [PAYMENT_EVENT_RECEIVED] }).pipe(
    Effect.flatMap((claimed) =>
      claimed[0] === undefined
        ? Effect.die(`${workerId} claimed nothing`)
        : Effect.succeed(claimed[0]),
    ),
  );

/** The reaper requeues `id` as if its worker died (lock aged past the timeout). */
const reap = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    yield* sql`UPDATE messages SET "lockedAt" = now() - interval '10 minutes' WHERE id = ${id}`;
    assert.equal(yield* reapStale(sql)(300), 1, 'the reaper requeued it');
  });

/**
 * Attempt 1 claims the message and holds the settlement transaction right after
 * `lockMatchResult`; the reaper requeues it and attempt 2 claims it again and starts.
 * Postgres parks attempt 2 on the `charges` row — already at its raw upsert (ON CONFLICT
 * DO UPDATE takes the row lock attempt 1 holds), before it reaches `lockMatchResult`.
 * Attempt 1 is then released and commits.
 */
const reaperOverlap = (charge: Charge) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* ChargePipeline).ingest(charge);
    const first = yield* takeCharge(sql, 'worker-a');
    const gate = yield* makeGate;
    const attempt1 = yield* settlementHandler({
      repo: holdingMatchLock(makeChargeRepo(sql), gate),
    });
    const a = yield* Effect.fork(attempt1(first.payload));
    yield* gate.reached;
    yield* reap(sql, first.id);
    const second = yield* takeCharge(sql, 'worker-b');
    assert.equal(second.id, first.id, 'attempt 2 claimed the same message');
    assert.equal(second.attemptCount, 2);
    const b = yield* Effect.fork((yield* settlementHandler())(second.payload));
    yield* awaitLockWait(sql, '%INTO charges%ON CONFLICT%');
    yield* openGate(gate);
    yield* Fiber.join(Fiber.zip(a, b));
  });

const settledOnce = (idemKey: string, event: string): readonly Check[] => [
  [matchResultSql(idemKey), 'matched', "matchResult stays 'matched'"],
  [`SELECT count(*) FROM quarantine_records`, '0', 'no quarantine row'],
  [
    countEventsSql('unknown_payment_quarantined'),
    '0',
    'no unknown_payment_quarantined',
  ],
  [countEventsSql(event), '1', `exactly one ${event}`],
];

const T24_KEY = 'w4pcb:chk_t24|Approved';

const driveT24 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const sub = yield* seedSub(subs, {
    externalUserId: 'sp:t24',
    end: BARRIER_END,
  });
  yield* makeCheckoutRepo(sql).insert(
    prolongSession(sub, 'chk_t24', FAR, null),
  );
  yield* reaperOverlap(callback('chk_t24', T24_KEY, new Date('2026-02-20')));
  return yield* current(subs, sub.id);
});

const t24ReaperOverlap: EffectScenario = {
  name: 'reaper (T24): a reaped redelivery waits on the settlement lock and returns on matched — one stack, one event',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const final = await run(driveT24);
      assert.equal(endMs(final), BARRIER_END.getTime() + P4W, 'one stack');
      await expectRows(query, [
        [`SELECT count(*) FROM charge_fixations`, '1', 'one fixation'],
        ...settledOnce(T24_KEY, 'recurring_payment_succeeded'),
      ]);
    }),
};

const T24_PROLONG_DECLINE = 'w4pcb:chk_t24d|Declined';
const T24_PLAIN_DECLINE = 'w4pcb:chk_t24i|Declined';
const DECLINED = { status: 'failed', payload: { reason: 'declined' } } as const;

/** A declined prolong under the reaper overlap, then replays of it and of a declined
 * first checkout (no sub). */
const driveT24Decline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkout = makeCheckoutRepo(sql);
  const subs = makePaymentRepo(sql);
  const sub = yield* seedSub(subs, {
    externalUserId: 'sp:t24d',
    end: BARRIER_END,
  });
  yield* checkout.insert(prolongSession(sub, 'chk_t24d', FAR, null));
  yield* checkout.insert({
    ...prolongSession(sub, 'chk_t24i', FAR, null),
    externalUserId: 'sp:t24-new',
    origin: null,
    renewalOf: null,
    options: null,
  });
  const prolong = callback(
    'chk_t24d',
    T24_PROLONG_DECLINE,
    new Date(),
    DECLINED,
  );
  const plain = callback('chk_t24i', T24_PLAIN_DECLINE, new Date(), DECLINED);
  yield* reaperOverlap(prolong);
  const handler = yield* settlementHandler();
  yield* handler(asPayload(plain));
  yield* handler(asPayload(plain));
  yield* handler(asPayload(prolong));
  return yield* current(subs, sub.id);
});

const t24DeclineReplay: EffectScenario = {
  name: 'reaper (T24): the same overlap on a declined charge emits one failure; a replay is a no-op',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const final = await run(driveT24Decline);
      assert.equal(
        endMs(final),
        BARRIER_END.getTime(),
        'a decline adds no time',
      );
      await expectRows(query, [
        ...settledOnce(T24_PROLONG_DECLINE, 'recurring_payment_failed'),
        ...settledOnce(T24_PLAIN_DECLINE, 'initial_payment_failed'),
        [
          `SELECT string_agg(status::text, ',') FROM checkout_sessions`,
          `${CREATED},${CREATED}`,
          'both sessions stay payable',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T28 — a paid prolong un-cancels; the queued lapse does nothing.
// ---------------------------------------------------------------------------------

const driveT28 = Effect.gen(function* () {
  yield* registerHandlers;
  const subs = makePaymentRepo(yield* SqlClient.SqlClient);
  const sub = yield* seedDueCancelPending('sp:t28');
  yield* tick();
  // Settled before the dispatcher reaches the (older) lapse message.
  yield* settleProlong(sub, 'chk_t28');
  yield* runFor(1.5);
  return { sub, afterLapse: yield* current(subs, sub.id) };
});

/** At the new due date the sub renews normally. */
const renewAtNewDueDate = (id: string) =>
  Effect.gen(function* () {
    const subs = makePaymentRepo(yield* SqlClient.SqlClient);
    yield* ageRow(id, P4W + HOUR);
    const aged = yield* current(subs, id);
    yield* tick({ client: approving });
    yield* runFor(2);
    return { aged, final: yield* current(subs, id) };
  });

/** Event names in publish order (each event's first `deliver_event` message). */
const PUBLISH_ORDER_SQL = `SELECT string_agg(name, ',' ORDER BY first) FROM (
  SELECT e.name, min(m.id) AS first FROM messages m
  JOIN event_deliveries d ON d.id::text = m.payload->>'deliveryId'
  JOIN domain_events e ON e.id = d."eventId"
  WHERE m."messageType" = 'deliver_event' GROUP BY e.name) x`;

const t28ProlongBeatsLapse: EffectScenario = {
  name: 'lapse (T28): a prolong paid after the lapse was queued clears the cancel; the lapse does nothing',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const { sub, afterLapse } = await run(driveT28);
      assert.equal(afterLapse.status, PaymentStatus.Active);
      assert.equal(afterLapse.cancelRequestedAt, null, 'the cancel is cleared');
      assert.equal(endMs(afterLapse), endMs(sub) + P4W);
      await expectRows(query, [
        [
          `SELECT status FROM messages WHERE "messageType" = 'payment_lapse'`,
          'success',
          'the queued lapse ran',
        ],
        [countEventsSql('renewal_failed'), '0', 'the lapse did nothing'],
        [
          PUBLISH_ORDER_SQL,
          'payment_reactivated,recurring_payment_succeeded',
          'payment_reactivated, then recurring_payment_succeeded',
        ],
      ]);
      const renewed = await run(renewAtNewDueDate(sub.id));
      assert.equal(endMs(renewed.final), endMs(renewed.aged) + P4W, 'renewed');
      await expectRows(query, [
        [
          `SELECT count(*) FROM messages WHERE "messageType" = 'payment_lapse'`,
          '1',
          'no new lapse at the next due date',
        ],
        [
          countEventsSql('recurring_payment_succeeded'),
          '2',
          'prolong + renewal',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T33 — crypto manual renewals (AC 25), paid live, after death, declined, replayed.
// ---------------------------------------------------------------------------------

const MANUAL_END = new Date('2026-05-01T00:00:00Z');

/** A crypto, token-less sub. */
const cryptoSub = (externalUserId: string, status: PaymentStatus) => ({
  externalUserId,
  end: MANUAL_END,
  status,
  method: PaymentMethod.Crypto,
  token: null,
  currency: USD,
  firstFailureAt: status === PaymentStatus.Active ? null : MANUAL_END,
});

/** A crypto sub in `status` with its manual-renewal link, as the minter makes it. */
const seedManual = (externalUserId: string, status: PaymentStatus) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sub = yield* seedSub(
      makePaymentRepo(sql),
      cryptoSub(externalUserId, status),
    );
    const key = `manual:${sub.id}:${ms(MANUAL_END)}`;
    const chk = `chk_${externalUserId.replace('sp:', '')}`;
    yield* makeCheckoutRepo(sql).insert(
      manualRenewalSession(sub, chk, FAR, key),
    );
    return sub.id;
  });

const driveT33 = Effect.gen(function* () {
  yield* registerHandlers;
  const ids = {
    a: yield* seedManual('sp:t33a', PaymentStatus.PastDue),
    b: yield* seedManual('sp:t33b', PaymentStatus.RenewalFailed),
    c: yield* seedManual('sp:t33c', PaymentStatus.Cancelled),
    d: yield* seedManual('sp:t33d', PaymentStatus.RenewalFailed),
  };
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest(whitepay('chk_t33a', 'succeeded'));
  yield* pipeline.ingest(whitepay('chk_t33b', 'succeeded'));
  yield* pipeline.ingest(whitepay('chk_t33c', 'succeeded'));
  yield* pipeline.ingest(whitepay('chk_t33d', 'failed'));
  yield* runFor(2);
  return ids;
});

const replayT33 = Effect.gen(function* () {
  const handler = yield* settlementHandler();
  yield* handler(asPayload(whitepay('chk_t33b', 'succeeded')));
  yield* handler(asPayload(whitepay('chk_t33d', 'failed')));
});

/** `name:aggregateId` of every event a contact got, sorted by name. */
const eventsOfSql = (externalUserId: string) =>
  `SELECT coalesce(string_agg(name || ':' || "aggregateId", ',' ORDER BY name), '') FROM domain_events WHERE "externalUserId" = '${externalUserId}'`;

/** The contact's row other than `dead` (the fresh sub a payment after death made). */
const freshRowSql = (externalUserId: string, dead: string) =>
  `SELECT id FROM payments WHERE "externalUserId" = '${externalUserId}' AND id <> '${dead}'`;

/** status | method | token | end(ms) of one payment. */
const rowStateSql = (id: string) =>
  `SELECT status || '|' || method || '|' || coalesce("recurringTokenRef", 'null') || '|' || (extract(epoch FROM "currentPeriodEnd") * 1000)::bigint FROM payments WHERE id = '${id}'`;

/** (b)/(c): a payment after death made exactly one fresh, Active, recurring row. */
const paidAfterDeath = (
  contact: string,
  dead: string,
  deadStatus: PaymentStatus,
  fresh: string,
): readonly Check[] => [
  [
    eventsOfSql(contact),
    `payment_created:${fresh},recurring_payment_succeeded:${fresh}`,
    `${contact}: payment_created + recurring success on the fresh row, no initial_*`,
  ],
  [
    `SELECT payload ? 'renewal' FROM domain_events WHERE name = 'payment_created' AND "externalUserId" = '${contact}'`,
    't',
    `${contact}: payment_created carries renewal`,
  ],
  [
    rowStateSql(dead),
    `${String(deadStatus)}|1|null|${ms(MANUAL_END)}`,
    `${contact}: the dead row is untouched`,
  ],
  [
    `SELECT status FROM payments WHERE id = '${fresh}'`,
    '0',
    'fresh row Active',
  ],
];

const t33LiveAndDeclined = (a: string, d: string): readonly Check[] => [
  [
    rowStateSql(a),
    `0|1|null|${ms(new Date(MANUAL_END.getTime() + P4W))}`,
    '(a) stacked on the PastDue row, Active again',
  ],
  [
    eventsOfSql('sp:t33a'),
    `recurring_payment_succeeded:${a}`,
    '(a) no payment_created',
  ],
  [
    eventsOfSql('sp:t33d'),
    `recurring_payment_failed:${d}`,
    '(d) the decline is attributed to the dead row (renewalOf)',
  ],
  [
    `SELECT count(*) FROM payments WHERE "externalUserId" = 'sp:t33d'`,
    '1',
    '(d) no sub row written',
  ],
  [sessionStatusSql('chk_t33d'), CREATED, '(d) the session stays payable'],
];

const t33CryptoManualRenewal: EffectScenario = {
  name: 'manual renewal (T33): crypto paid while PastDue stacks; after RenewalFailed/Cancelled a fresh recurring sub; decline names the dead sub; replays are no-ops',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const ids = await run(driveT33);
      const freshB = await trimmed(query, freshRowSql('sp:t33b', ids.b));
      const freshC = await trimmed(query, freshRowSql('sp:t33c', ids.c));
      await expectRows(query, [
        ...t33LiveAndDeclined(ids.a, ids.d),
        ...paidAfterDeath(
          'sp:t33b',
          ids.b,
          PaymentStatus.RenewalFailed,
          freshB,
        ),
        ...paidAfterDeath('sp:t33c', ids.c, PaymentStatus.Cancelled, freshC),
      ]);
      // (e) replays of (b) and (d) emit nothing more.
      const before = await trimmed(query, `SELECT count(*) FROM domain_events`);
      await run(replayT33);
      await expectRows(query, [
        [`SELECT count(*) FROM domain_events`, before, '(e) no second event'],
        [
          `SELECT count(*) FROM payments WHERE "externalUserId" = 'sp:t33b'`,
          '2',
          '(e) no second fresh row',
        ],
      ]);
    }),
};

/** A crypto renewal on its last ladder step: the day-7 tick ends it, then the WhitePay
 * success for its manual link arrives. */
const driveT33f = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const firstFailureAt = new Date(Date.now() - 8 * DAY);
  const sub = yield* seedSub(makePaymentRepo(sql), {
    ...cryptoSub('sp:t33f', PaymentStatus.PastDue),
    end: firstFailureAt,
    nextPaymentDate: new Date(Date.now() - HOUR),
    firstFailureAt,
    retryAttempt: 4,
  });
  const key = `manual:${sub.id}:${ms(firstFailureAt)}`;
  yield* makeCheckoutRepo(sql).insert(
    manualRenewalSession(sub, 'chk_t33f', FAR, key),
  );
  yield* tick();
  const dead = yield* current(makePaymentRepo(sql), sub.id);
  yield* (yield* ChargePipeline).ingest(whitepay('chk_t33f', 'succeeded'));
  yield* runFor(2);
  return dead;
});

const t33PaidAfterDay7: EffectScenario = {
  name: 'manual renewal (T33f): a WhitePay success after the day-7 tick killed the sub starts a fresh recurring sub',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const dead = await run(driveT33f);
      assert.equal(
        dead.status,
        PaymentStatus.RenewalFailed,
        'the ladder ended',
      );
      const fresh = await trimmed(query, freshRowSql('sp:t33f', dead.id));
      await expectRows(query, [
        [
          eventsOfSql('sp:t33f'),
          `payment_created:${fresh},recurring_payment_succeeded:${fresh},renewal_failed:${dead.id}`,
          'renewal_failed, then a fresh sub reported as a recurring payment',
        ],
      ]);
    }),
};

/**
 * 6 Oct: a CARD subscription whose renewal ladder ended (`renewal_failed`), recovered by
 * the buyer through its manual-pay link («Оплатить сейчас») and paid by card. Decision 7
 * (2026-10-20): a recovered renewal is reported as a renewal, never as a first purchase,
 * so the chatbot does not run onboarding again.
 */
const driveOct6 = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const sub = yield* seedSub(makePaymentRepo(sql), {
    externalUserId: 'sp:oct6',
    end: MANUAL_END,
    status: PaymentStatus.RenewalFailed,
    firstFailureAt: MANUAL_END,
  });
  yield* makeCheckoutRepo(sql).insert(
    manualRenewalSession(
      sub,
      'chk_oct6',
      FAR,
      `manual:${sub.id}:${ms(MANUAL_END)}`,
    ),
  );
  yield* (yield* ChargePipeline).ingest(
    callback(
      'chk_oct6',
      'w4pcb:chk_oct6|Approved',
      new Date('2026-05-03T00:00:00Z'),
      {
        payload: { recToken: 'tok_new' },
      },
    ),
  );
  yield* runFor(2);
  return sub.id;
});

const oct6RecoveredRenewal: EffectScenario = {
  name: 'manual renewal (6 Oct): a renewal_failed card sub paid through its manual-pay link reports recurring_payment_succeeded, not initial',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const dead = await run(driveOct6);
      const fresh = await trimmed(query, freshRowSql('sp:oct6', dead));
      await expectRows(query, [
        [
          eventsOfSql('sp:oct6'),
          `payment_created:${fresh},recurring_payment_succeeded:${fresh}`,
          'the recovery is a recurring payment; no initial_payment_succeeded',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T36 — an old-code attempt killed between 'matched' and its apply (drain gate).
// ---------------------------------------------------------------------------------

/** Verbatim from billing-service-deploy `scripts/drain-gate.sh`: keep in step. */
const DRAIN_GATE_SQL = `SELECT id, status, "retryAt", "lockedAt" FROM messages
                  WHERE "messageType" = 'payment_event_received'
                    AND status IN ('in_progress', 'retry')`;

const T36_END = new Date('2026-01-01T00:00:00Z');

/** A pre-0021 owed card change (origin NULL, priced → legacy arrears). */
const legacyCardChange = (sub: Payment): NewCheckoutSession => ({
  ...prolongSession(sub, 'chk_t36', FAR, null),
  kind: CheckoutSessionKind.CardChange,
  paymentId: sub.id,
  origin: null,
  renewalOf: null,
  options: null,
});

/** What the old worker leaves: the message claimed (in_progress), the charge upserted
 * and marked 'matched' (old charge/domain.ts:338), its apply never run. */
const driveT36 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sub = yield* seedSub(makePaymentRepo(sql), {
    externalUserId: 'sp:t36',
    end: T36_END,
    status: PaymentStatus.PastDue,
    firstFailureAt: T36_END,
    retryAttempt: 2,
  });
  yield* makeCheckoutRepo(sql).insert(legacyCardChange(sub));
  const charge = callback('chk_t36', 'w4pcb:chk_t36|Approved', new Date(), {
    payload: { recToken: 'new' },
  });
  yield* (yield* ChargePipeline).ingest(charge);
  const claimed = yield* takeCharge(sql, 'old-worker');
  const repo = makeChargeRepo(sql);
  yield* repo.setMatchResult(
    yield* repo.upsertIncomingCharge(charge),
    'matched',
  );
  const gate = yield* sql.unsafe<{
    readonly id: string;
    readonly status: string;
  }>(DRAIN_GATE_SQL);
  // (b) Were the new worker started anyway, it would short-circuit and apply nothing.
  yield* (yield* settlementHandler())(claimed.payload);
  return { sub, gate, messageId: claimed.id };
});

const t36LegacyTransition: EffectScenario = {
  name: "legacy (T36): an old card-change attempt left 'matched' before its apply is caught by the drain gate; the new worker would skip it",
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const out = await run(driveT36);
      assert.deepEqual(
        out.gate.map((r) => [r.id, r.status]),
        [[out.messageId, 'in_progress']],
        '(a) the drain-gate query returns the stranded message, so the gate exits 1',
      );
      await expectRows(query, [
        [
          rowStateSql(out.sub.id),
          `${String(PaymentStatus.PastDue)}|0|tok_old|${ms(T36_END)}`,
          '(b) no token, no revive, no advance: the paid change is lost',
        ],
        [sessionStatusSql('chk_t36'), CREATED, '(b) never completed'],
        [`SELECT count(*) FROM domain_events`, '0', '(b) no event'],
        [`SELECT count(*) FROM charge_fixations`, '0', '(b) no fixation'],
        [`SELECT count(*) FROM quarantine_records`, '0', '(b) no quarantine'],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T37 — X12: the scheduler's tx 2 is all-or-nothing on real Postgres.
// ---------------------------------------------------------------------------------

/** What another connection sees of one sub's settlement: next date | claims | messages. */
const committedSettlementSql = (sub: Payment) =>
  `SELECT (SELECT (extract(epoch FROM "nextPaymentDate") * 1000)::bigint FROM payments WHERE id = '${sub.id}')
     || '|' || (SELECT count(*) FROM idempotency_keys WHERE scope = 'scheduler.advance' AND "idemKey" = '${orderReferenceOf(sub)}')
     || '|' || (SELECT count(*) FROM messages WHERE "messageType" = 'payment_event_received')`;

/**
 * An ingest that fails on its first call; on the retry it first records what is
 * COMMITTED (psql, its own session) — the failed attempt's leftovers, if any — then
 * enqueues for real.
 */
const failingOnceIngest = (
  query: Query,
  sub: Payment,
  seen: string[],
  ingest: SchedulerDeps['ingest'],
): SchedulerDeps['ingest'] => {
  let calls = 0;
  return (event) => {
    calls += 1;
    if (calls === 1) {
      return Effect.fail(injectedFault('enqueue in tx 2'));
    }
    return Effect.promise(() =>
      trimmed(query, committedSettlementSql(sub)),
    ).pipe(
      Effect.tap((s) => Effect.sync(() => seen.push(s))),
      Effect.andThen(ingest(event)),
    );
  };
};

const seedDue = (externalUserId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    seedSub(makePaymentRepo(sql), {
      externalUserId,
      end: new Date(Date.now() - HOUR),
    }),
  );

const driveT37 = (query: Query, seen: string[]) =>
  Effect.gen(function* () {
    const sub = yield* seedDue('sp:t37');
    const ingest = (yield* ChargePipeline).ingest;
    yield* tick({
      client: approving,
      ingest: failingOnceIngest(query, sub, seen, ingest),
    });
    return sub;
  });

const t37SchedulerTx2: EffectScenario = {
  name: 'scheduler (T37): a failed enqueue in tx 2 rolls back the advance and the claim; the bounded retry commits exactly once',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const seen: string[] = [];
      const sub = await run(driveT37(query, seen));
      assert.deepEqual(
        seen,
        [`${ms(sub.nextPaymentDate)}|0|0`],
        'after the failed attempt: no advance, no claim, no message (rolled back together)',
      );
      await expectRows(query, [
        [
          committedSettlementSql(sub),
          `${(sub.nextPaymentDate.getTime() + P4W).toString()}|1|1`,
          'after the retry: exactly one advance, one claim, one message',
        ],
      ]);
    }),
};

const driveT37Exhausted = (layer: ReturnType<typeof captureLogs>['layer']) =>
  Effect.gen(function* () {
    const sub = yield* seedDue('sp:t37x');
    let calls = 0;
    const ingest: SchedulerDeps['ingest'] = () => {
      calls += 1;
      return Effect.fail(injectedFault('enqueue in tx 2'));
    };
    yield* tick({ client: approving, ingest }).pipe(Effect.provide(layer));
    return { sub, calls };
  });

const t37SchedulerTx2Exhausted: EffectScenario = {
  name: 'scheduler (T37): when every tx 2 attempt fails, nothing is recorded and SETTLEMENT_ANOMALY is logged once',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const logs = captureLogs();
      const { sub, calls } = await run(driveT37Exhausted(logs.layer));
      assert.equal(calls, 4, 'one attempt and three bounded retries');
      assert.equal(
        logs.lines.filter((l) => l.startsWith('SETTLEMENT_ANOMALY')).join('\n'),
        'SETTLEMENT_ANOMALY scheduler: approved charge not recorded',
        'exactly one SETTLEMENT_ANOMALY',
      );
      await expectRows(query, [
        [
          committedSettlementSql(sub),
          `${ms(sub.nextPaymentDate)}|0|0`,
          'no advance, no claim, no message',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T38 — exact renewal attribution, the 0021 backfill, the documented legacy gap.
// ---------------------------------------------------------------------------------

/** A crypto sub of 'sp:t38' that has died. */
const seedDeadT38 = (subs: PaymentRepo, end: Date) =>
  seedSub(subs, { ...cryptoSub('sp:t38', PaymentStatus.PastDue), end }).pipe(
    Effect.tap((sub) => subs.markRenewalFailed(sub.id)),
  );

/** The re-issue `/pay` makes of a lapsed link while the contact has no live sub. */
const reissue = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const checkout = makeCheckoutRepo(sql);
    const live =
      yield* makePaymentRepo(sql).findActiveRecurringByExternalUser('sp:t38');
    assert.ok(Option.isNone(live), 'no live sub');
    const stale = yield* checkout.findById(id);
    assert.ok(Option.isSome(stale));
    const effective = Either.getOrThrow(
      effectivePayable(stale.value, live, Date.now(), 3600),
    );
    assert.equal(effective._tag, 'Reissue', 'a plain clone');
    return yield* checkout.reissueLapsed(effective.intent);
  });

/** A's manual link (since lapsed); A dies; the contact buys B; B dies; A's link is
 * clicked (re-issued), declined, then paid. */
const driveT38a = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const a = yield* seedDeadT38(subs, MANUAL_END);
  const key = `manual:${a.id}:${ms(MANUAL_END)}`;
  const lapsed = new Date(Date.now() - HOUR);
  yield* makeCheckoutRepo(sql).insert(
    manualRenewalSession(a, 'chk_t38a', lapsed, key),
  );
  const b = yield* seedDeadT38(subs, new Date('2026-07-01T00:00:00Z'));
  const cloneId = yield* reissue(sql, 'chk_t38a');
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest(whitepay(cloneId, 'failed'));
  yield* runFor(1.5);
  yield* pipeline.ingest(whitepay(cloneId, 'succeeded'));
  yield* runFor(1.5);
  return { a: a.id, b: b.id, cloneId };
});

const t38TwoDeadSubs: EffectScenario = {
  name: 'attribution (T38a): a reissued manual link of dead sub A declines on A (not the later dead B); paid → fresh recurring sub',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const { a, b, cloneId } = await run(driveT38a);
      const fresh = await trimmed(
        query,
        `SELECT id FROM payments WHERE id NOT IN ('${a}', '${b}')`,
      );
      await expectRows(query, [
        [
          `SELECT coalesce("idempotencyKey", '-') || '|' || origin || '|' || "renewalOf" FROM checkout_sessions WHERE id = '${cloneId}'`,
          `-|manual_renewal|${a}`,
          'the keyless clone keeps origin and renewalOf = A',
        ],
        [
          eventsOfSql('sp:t38'),
          `payment_created:${fresh},recurring_payment_failed:${a},recurring_payment_succeeded:${fresh}`,
          'the decline names A (not B); paid → a fresh recurring row',
        ],
      ]);
    }),
};

/** A pre-deploy session row (origin/renewalOf NULL) for the backfill fixtures. */
const legacyRow = (
  id: string,
  externalUserId: string,
  idempotencyKey: string | null,
  extra: Partial<NewCheckoutSession> = {},
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: 30000,
  currency: USD,
  period: 'P4W',
  method: PaymentMethod.Crypto,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: null,
  renewalOf: null,
  options: null,
  idempotencyKey,
  email: '',
  expiresAt: FAR,
  ...extra,
});

/** One genuine pre-deploy manual session and every look-alike the backfill must skip. */
const backfillFixtures = (m: string, other: string): NewCheckoutSession[] => [
  legacyRow('chk_m1_genuine', 'sp:t38m', `manual:${m}:111`),
  legacyRow('chk_m2_plain_key', 'sp:t38m', 'caller-key-1'),
  legacyRow('chk_m3_no_key', 'sp:t38m', null),
  legacyRow('chk_m4_no_such_sub', 'sp:t38m', `manual:${randomUUID()}:112`),
  legacyRow('chk_m5_other_contact', 'sp:t38m', `manual:${other}:113`),
  legacyRow('chk_m6_not_uuid', 'sp:t38m', 'manual:abc:1'),
  legacyRow('chk_m7_one_time', 'sp:t38m', `manual:${m}:114`, {
    recurring: false,
  }),
  legacyRow('chk_m8_card_change', 'sp:t38m', `manual:${m}:115`, {
    kind: CheckoutSessionKind.CardChange,
    paymentId: m,
  }),
  legacyRow('chk_m9_has_payment', 'sp:t38m', `manual:${m}:116`, {
    paymentId: m,
  }),
];

/** The migration's `up`, as the migrator runs it: in one transaction. */
const migrate0021 = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql.withTransaction(migration0021),
);

/** Pre-deploy rows (dead sub M with a manual: session and look-alikes; dead sub D with a
 * keyless clone), then 0021. */
const driveT38Backfill = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const checkout = makeCheckoutRepo(sql);
  const dead = PaymentStatus.RenewalFailed;
  const m = yield* seedSub(subs, cryptoSub('sp:t38m', dead));
  const other = yield* seedSub(
    subs,
    cryptoSub('sp:t38x', PaymentStatus.Active),
  );
  const d = yield* seedSub(subs, cryptoSub('sp:t38d', dead));
  const rows = [
    ...backfillFixtures(m.id, other.id),
    legacyRow('chk_t38d_clone', 'sp:t38d', null),
  ];
  yield* Effect.forEach(rows, (row) => checkout.insert(row));
  yield* migrate0021;
  return { m: m.id, d: d.id };
});

/** After deploy: the minter re-mints on M's key (and must reuse the backfilled row); a
 * decline arrives on it, and the keyless clone of D is paid. */
const afterDeploy = (mId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkout = makeCheckoutRepo(sql);
    const m = yield* current(makePaymentRepo(sql), mId);
    const key = `manual:${mId}:111`;
    const inserted = yield* checkout.insert(
      manualRenewalSession(m, 'chk_new_after_deploy', FAR, key),
    );
    const reused = yield* checkout.findByIdempotencyKey(key);
    const pipeline = yield* ChargePipeline;
    yield* pipeline.ingest(whitepay('chk_m1_genuine', 'failed'));
    yield* pipeline.ingest(whitepay('chk_t38d_clone', 'succeeded'));
    yield* runFor(2);
    return { inserted, reused: Option.getOrNull(reused) };
  });

const BACKFILL_SNAPSHOT = `SELECT string_agg(id || ':' || coalesce(origin, '-') || ':' || coalesce("renewalOf", '-'), ',' ORDER BY id) FROM checkout_sessions WHERE id LIKE 'chk_m%'`;

const RECURRING_FAILED_IN_SCOPE = `SELECT count(*) FROM sinks, jsonb_array_elements_text(config->'events') e WHERE kind = 2 AND e = 'recurring_payment_failed'`;

const backfilled = (m: string): readonly Check[] => [
  [
    BACKFILL_SNAPSHOT,
    [
      `chk_m1_genuine:manual_renewal:${m}`,
      'chk_m2_plain_key:-:-',
      'chk_m3_no_key:-:-',
      'chk_m4_no_such_sub:-:-',
      'chk_m5_other_contact:-:-',
      'chk_m6_not_uuid:-:-',
      'chk_m7_one_time:-:-',
      'chk_m8_card_change:-:-',
      'chk_m9_has_payment:-:-',
    ].join(','),
    '(b) only the genuine manual: row is labelled',
  ],
  [RECURRING_FAILED_IN_SCOPE, '1', '(b) the email sink scope lists it once'],
];

const t38Backfill: EffectScenario = {
  name: 'attribution (T38b–d): 0021 backfills only genuine manual: sessions, re-runs as a no-op; the minter reuses it; a keyless clone stays initial_*',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const ids = await run(driveT38Backfill);
      await expectRows(query, backfilled(ids.m));
      await run(migrate0021);
      await expectRows(query, backfilled(ids.m)); // the re-run is a no-op
      const { inserted, reused } = await run(afterDeploy(ids.m));
      assert.equal(inserted, false, '(c) the key collapses the re-mint');
      assert.equal(reused?.id, 'chk_m1_genuine', '(c) the backfilled row');
      const fresh = await trimmed(query, freshRowSql('sp:t38d', ids.d));
      await expectRows(query, [
        [
          eventsOfSql('sp:t38m'),
          `recurring_payment_failed:${ids.m}`,
          '(c) the decline names the dead sub',
        ],
        [
          eventsOfSql('sp:t38d'),
          `initial_payment_succeeded:${fresh},payment_created:${fresh}`,
          '(d) the documented gap: a keyless pre-deploy clone reports initial_*',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// T31 / T35 claim-time backstops (the races HTTP cannot stage deterministically).
// ---------------------------------------------------------------------------------

/** The method changed between the pre-check and the claim: the first read sees a
 * Crypto-locked row, the row is Card-locked by the time the claim runs. */
const racedMethodLock = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const subs = makePaymentRepo(sql);
    const checkout = makeCheckoutRepo(sql);
    const card = yield* seedSub(subs, {
      externalUserId: 'sp:bs-lock',
      end: FAR,
    });
    yield* checkout.insert(prolongSession(card, 'chk_bs_lock', FAR, null));
    let reads = 0;
    const stale = (found: Option.Option<CheckoutSession>) => {
      reads += 1;
      return reads === 1
        ? Option.map(found, (s) => ({ ...s, method: PaymentMethod.Crypto }))
        : found;
    };
    const sessions = {
      ...checkout,
      findById: (id: string) => checkout.findById(id).pipe(Effect.map(stale)),
    };
    const findActiveRecurring = subs.findActiveRecurringByExternalUser;
    return yield* Effect.either(
      claimPayableSession(
        { sessions, findActiveRecurring },
        'chk_bs_lock',
        { method: PaymentMethod.Crypto },
        Date.now(),
      ),
    );
  });

/** Q8: an intro link whose contact gains a live sub after the pre-check. */
const lateLiveSub = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const subs = makePaymentRepo(sql);
    const repos = {
      sessions: makeCheckoutRepo(sql),
      findActiveRecurring: subs.findActiveRecurringByExternalUser,
    };
    yield* repos.sessions.insert(
      legacyRow('chk_bs_intro', 'sp:bs-q8', null, {
        amount: 100,
        period: 'P1W',
        method: PaymentMethod.Card,
        renewal: { amount: 30000, period: 'P4W' },
      }),
    );
    const now = Date.now();
    const card = { method: PaymentMethod.Card };
    const id = yield* resolvePayableSessionId(
      repos,
      'chk_bs_intro',
      card,
      now,
      3600,
    );
    yield* seedSub(subs, { externalUserId: 'sp:bs-q8', end: FAR });
    return yield* Effect.either(claimPayableSession(repos, id, card, now));
  });

const driveBackstops = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkout = makeCheckoutRepo(sql);
  const locked = yield* racedMethodLock(sql);
  const crypto = yield* checkout.claimForPayment(
    'chk_bs_lock',
    PaymentMethod.Crypto,
  );
  const card = yield* checkout.claimForPayment(
    'chk_bs_lock',
    PaymentMethod.Card,
  );
  const q8 = yield* lateLiveSub(sql);
  return { locked, crypto, card, q8 };
});

const payBackstops: EffectScenario = {
  name: 'pay (T31/T35): claimForPayment refuses a locked method in SQL; Q8 re-checks at claim time',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const out = await run(driveBackstops);
      assert.ok(Either.isLeft(out.locked), 'the raced claim lost');
      assert.equal(out.locked.left._tag, 'MethodLocked', 'as MethodLocked');
      assert.equal(out.locked.left.method, PaymentMethod.Card, 'naming Card');
      assert.equal(
        out.crypto,
        false,
        'the SQL predicate refuses another method',
      );
      assert.equal(out.card, true, 'the locked method still claims');
      assert.ok(Either.isLeft(out.q8), 'the late claim lost');
      assert.equal(out.q8.left._tag, 'AlreadySubscribed', 'Q8 at claim time');
      await expectRows(query, [
        [
          sessionStatusSql('chk_bs_intro'),
          CREATED,
          'the intro link is untouched',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// Fix round M1 — an intro link claimed before the sub existed is refused at settlement.
// ---------------------------------------------------------------------------------

const INTRO_TERMS = {
  amount: 100,
  currency: 0,
  period: 'P1W',
  method: PaymentMethod.Card,
  renewal: { amount: 30000, period: 'P4W' },
} as const;

const M1_PAID_AT = new Date('2026-04-01T00:00:00Z');
const m1Charge = (chk: string) =>
  callback(chk, `w4pcb:${chk}|Approved`, M1_PAID_AT, {
    amount: 100,
    payload: { recToken: `tok_${chk}` },
  });

/** `/pay` with Card on `id`, through the route's own preflight and claim. */
const claimByCard = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const repos = {
      sessions: makeCheckoutRepo(sql),
      findActiveRecurring:
        makePaymentRepo(sql).findActiveRecurringByExternalUser,
    };
    const now = Date.now();
    const card = { method: PaymentMethod.Card };
    const payable = yield* resolvePayableSessionId(repos, id, card, now, 3600);
    yield* claimPayableSession(repos, payable, card, now);
  });

/** A new contact claims two intro links (no sub yet), then the first one settles. */
const driveM1First = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const checkout = makeCheckoutRepo(sql);
  const ids = ['chk_m1_first', 'chk_m1_second'];
  yield* Effect.forEach(ids, (id) =>
    checkout.insert(legacyRow(id, 'sp:m1', null, INTRO_TERMS)),
  );
  yield* Effect.forEach(ids, (id) => claimByCard(sql, id));
  yield* (yield* settlementHandler())(asPayload(m1Charge('chk_m1_first')));
  const live =
    yield* makePaymentRepo(sql).findActiveRecurringByExternalUser('sp:m1');
  return Option.getOrThrow(live);
});

/** Settle the second intro charge, with the logs captured. */
const settleM1Second = (layer: ReturnType<typeof captureLogs>['layer']) =>
  settlementHandler().pipe(
    Effect.flatMap((handler) => handler(asPayload(m1Charge('chk_m1_second')))),
    Effect.provide(layer),
  );

/** Every column of the payment that a refused charge must leave byte-identical. */
const paymentBytesSql = (id: string) =>
  `SELECT row_to_json(p)::text FROM payments p WHERE id = '${id}'`;

const M1_ANOMALY =
  'SETTLEMENT_ANOMALY checkout: intro-priced payment on a live subscription';

const m1Refused = (sub: Payment, bytes: string): readonly Check[] => [
  [paymentBytesSql(sub.id), bytes, 'the payment row is byte-unchanged'],
  [
    sessionStatusSql('chk_m1_second'),
    String(CheckoutSessionStatus.Pending),
    'the completeIfOpen claim was undone with the savepoint (still Pending)',
  ],
  [
    matchResultSql('w4pcb:chk_m1_second|Approved'),
    'quarantined',
    'the charge is quarantined',
  ],
  [`SELECT count(*) FROM quarantine_records`, '1', 'one quarantine row'],
  [`SELECT count(*) FROM charge_fixations`, '1', 'only the first charge fixed'],
  [
    eventsOfSql('sp:m1'),
    `initial_payment_succeeded:${sub.id},payment_created:${sub.id}`,
    'no event for the refused charge beyond the quarantine notice',
  ],
  [
    countEventsSql('unknown_payment_quarantined'),
    '1',
    'one unknown_payment_quarantined (the refund candidate)',
  ],
];

const anomalies = (lines: readonly string[]) =>
  lines.filter((l) => l.startsWith('SETTLEMENT_ANOMALY'));

const m1IntroOnLiveRefused: EffectScenario = {
  name: 'settlement (M1): a second intro link claimed before the sub existed is refused at settlement — quarantined, nothing written, redelivery idem',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const sub = await run(driveM1First);
      assert.equal(sub.amount, 30000, 'the first charge stored renewal terms');
      assert.equal(sub.period, 'P4W');
      assert.equal(endMs(sub), M1_PAID_AT.getTime() + 7 * DAY, 'intro period');
      const bytes = await trimmed(query, paymentBytesSql(sub.id));
      const logs = captureLogs();
      await run(settleM1Second(logs.layer));
      assert.deepEqual(anomalies(logs.lines), [M1_ANOMALY], 'one marker');
      await expectRows(query, m1Refused(sub, bytes));
      // A redelivery re-runs ('quarantined' is not short-circuited) and writes nothing.
      await run(settleM1Second(logs.layer));
      assert.deepEqual(
        anomalies(logs.lines),
        [M1_ANOMALY, M1_ANOMALY],
        'the redelivery re-ran the settlement (refused again)',
      );
      await expectRows(query, m1Refused(sub, bytes));
    }),
};

const P28D_END = new Date('2026-06-01T00:00:00Z');

const driveP28D = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sub = yield* seedSub(makePaymentRepo(sql), {
    externalUserId: 'sp:p28d',
    end: P28D_END,
  });
  yield* makeCheckoutRepo(sql).insert(
    legacyRow('chk_p28d', 'sp:p28d', null, {
      currency: 0,
      method: PaymentMethod.Card,
      renewal: { amount: 30000, period: 'P28D' },
    }),
  );
  yield* (yield* settlementHandler())(
    asPayload(callback('chk_p28d', 'w4pcb:chk_p28d|Approved', new Date())),
  );
  return yield* current(makePaymentRepo(sql), sub.id);
});

const m1SamePeriodNotIntro: EffectScenario = {
  name: 'settlement (M1): renewal P28D over a P4W first charge at the same amount is not intro-priced — it stacks',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const final = await run(driveP28D);
      assert.equal(
        endMs(final),
        P28D_END.getTime() + P4W,
        'stacked one period',
      );
      assert.equal(final.period, 'P28D', 'renewal terms adopted');
      await expectRows(query, [
        [`SELECT count(*) FROM quarantine_records`, '0', 'not quarantined'],
        [
          eventsOfSql('sp:p28d'),
          `recurring_payment_succeeded:${final.id}`,
          'a prolongation',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// Fix round — a callback in another currency than the session's never settles.
// ---------------------------------------------------------------------------------

const CURRENCY_END = new Date('2026-08-01T00:00:00Z');

/** A USD sub with a USD prolong link, paid by a callback with `c`'s currency/amount. */
const payUsdProlong = (contact: string, c: ChargeSeed) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subs = makePaymentRepo(sql);
    const sub = yield* seedSub(subs, {
      externalUserId: contact,
      end: CURRENCY_END,
      currency: USD,
    });
    const chk = `chk_${contact.replace('sp:', '')}`;
    yield* makeCheckoutRepo(sql).insert(prolongSession(sub, chk, FAR, null));
    const paid = callback(chk, `w4pcb:${chk}|Approved`, new Date(), c);
    yield* (yield* settlementHandler())(asPayload(paid));
    return yield* current(subs, sub.id);
  });

const currencyMismatch: EffectScenario = {
  name: 'settlement (fix): a callback currency ≠ session currency is quarantined loudly; an amount-only mismatch settles with a warning',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const wrong = captureLogs();
      const untouched = await run(
        payUsdProlong('sp:cur', { currency: 0 }).pipe(
          Effect.provide(wrong.layer),
        ),
      );
      assert.deepEqual(anomalies(wrong.lines), [
        'SETTLEMENT_ANOMALY checkout: currency differs from session',
      ]);
      assert.equal(endMs(untouched), CURRENCY_END.getTime(), 'sub untouched');
      await expectRows(query, [
        [sessionStatusSql('chk_cur'), CREATED, 'the session stays payable'],
        [
          matchResultSql('w4pcb:chk_cur|Approved'),
          'quarantined',
          'quarantined',
        ],
        [`SELECT count(*) FROM charge_fixations`, '0', 'no fixation'],
      ]);
      const converted = captureLogs();
      const settled = await run(
        payUsdProlong('sp:amt', { currency: USD, amount: 29000 }).pipe(
          Effect.provide(converted.layer),
        ),
      );
      assert.ok(
        converted.lines.includes('settlement: amount differs from session'),
        'the amount difference is logged as a warning',
      );
      assert.deepEqual(anomalies(converted.lines), [], 'and is no anomaly');
      assert.equal(endMs(settled), CURRENCY_END.getTime() + P4W, 'stacked');
      assert.equal(settled.amount, 30000, 'stored at the session price');
    }),
};

export const renewalScenarios: readonly EffectScenario[] = [
  t15FailureInjection,
  t16BarrierSchedulerAdvance,
  t16BarrierRollback,
  t17DeferRacesProlong,
  t18StaleLapse,
  t18RecancelSamePeriod,
  t18LapseFailureInjection,
  t22LockScope,
  t22DeferAcrossDst,
  t24ReaperOverlap,
  t24DeclineReplay,
  t28ProlongBeatsLapse,
  t33CryptoManualRenewal,
  t33PaidAfterDay7,
  oct6RecoveredRenewal,
  t36LegacyTransition,
  t37SchedulerTx2,
  t37SchedulerTx2Exhausted,
  t38TwoDeadSubs,
  t38Backfill,
  payBackstops,
  m1IntroOnLiveRefused,
  m1SamePeriodNotIntro,
  currencyMismatch,
];
