import assert from 'node:assert/strict';

import { SqlClient, SqlError } from '@effect/sql';
import {
  type DomainEvent,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import {
  Deferred,
  Duration,
  Effect,
  Logger,
  type ManagedRuntime,
  Schema,
} from 'effect';

import type { AppConfig } from '@/config.js';
import { defaultRetryConfig, type RetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox } from '@/modules/outbox/domain.js';
import {
  Charge,
  type ChargeApplier,
  makeCompositeMatcher,
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@/modules/charge/contracts.js';
import {
  makeChargeRepo,
  type ChargeRepo,
} from '@/modules/charge/data-access.js';
import { ChargePipeline, handleChargeEvent } from '@/modules/charge/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  makeCardChangeMatcher,
  makeCheckoutApplier,
  makeCheckoutMatcher,
} from '@/modules/checkout/domain.js';
import { cancelNotify, lapseNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_CANCEL, PAYMENT_LAPSE } from '@/modules/payment/contracts.js';
import {
  makePaymentRepo,
  type PaymentRepo,
} from '@/modules/payment/data-access.js';
import { makeRecurringMatcher } from '@/modules/payment/matcher.js';
import { makeWorkerRuntime, type WorkerRuntime } from '@/runtime.js';

/**
 * Shared harness for the non-HTTP e2e scenarios (`pipeline.e2e.ts`, `renewal.e2e.ts`):
 * the scenario shape the runner drives, the worker handler set, a bounded dispatch
 * loop, and the seams a scenario uses to inject a failure or hold a transaction open.
 */
export interface EffectE2eContext {
  readonly config: AppConfig;
  /** Read-only SQL against this scenario's throwaway database (via psql). */
  readonly query: (sql: string) => Promise<string>;
}

export interface EffectScenario {
  readonly name: string;
  readonly run: (ctx: EffectE2eContext) => Promise<void>;
}

/** Register the worker handlers the scenarios drive. */
export const registerHandlers = Effect.gen(function* () {
  const registry = yield* TaskRegistry;
  const outbox = yield* Outbox;
  const pipeline = yield* ChargePipeline;
  const sql = yield* SqlClient.SqlClient;
  yield* registry.register(PAYMENT_EVENT_RECEIVED, (p) =>
    pipeline.handleFromPayload(p),
  );
  yield* registry.register(PAYMENT_REBIND, (p) =>
    pipeline.rebindFromPayload(p),
  );
  yield* registry.register(DELIVER_EVENT, (p) => outbox.deliverFromPayload(p));
  yield* registry.register(PAYMENT_CANCEL, cancelNotify(outbox.publish));
  yield* registry.register(
    PAYMENT_LAPSE,
    lapseNotify(makePaymentRepo(sql), outbox.publish),
  );
});

/** Run the dispatch loop for `seconds`, then stop (the loop is `Effect<never>`). */
export const runFor = (
  seconds: number,
  retry: RetryConfig = defaultRetryConfig,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue;
    yield* Effect.race(
      queue.run({
        workerId: 'e2e',
        pollIntervalMillis: 50,
        batchSize: 10,
        visibilityTimeoutMillis: 300_000,
        retry,
      }),
      Effect.sleep(Duration.seconds(seconds)),
    );
  });

/**
 * Upper bound on a drain, not an expected duration. Nothing should come close; if a drain
 * hits this, the queue is genuinely stuck and the test says so rather than asserting
 * against a half-processed database.
 */
const DRAIN_DEADLINE_SECONDS = 30;

/**
 * Is there any work the dispatcher could pick up right now?
 *
 * `retry` with a FUTURE `retryAt` does not count: a scenario that deliberately leaves a
 * failed delivery in backoff is quiescent, and waiting for it would hang until the
 * deadline. Only work that is claimable now keeps the drain going.
 */
const claimableNow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT count(*)::int AS count FROM messages
    WHERE status IN ('pending', 'in_progress')
       OR (status = 'retry' AND "retryAt" <= now())
  `;
  return rows[0]?.count ?? 1;
});

/** What is still outstanding, for a deadline failure that names the problem. */
const outstanding = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly messageType: string;
    readonly status: string;
    readonly count: number;
  }>`
    SELECT "messageType", status, count(*)::int AS count FROM messages
    WHERE status IN ('pending', 'in_progress')
       OR (status = 'retry' AND "retryAt" <= now())
    GROUP BY "messageType", status
  `;
  return rows
    .map((r) => `${r.messageType}/${r.status}=${r.count.toString()}`)
    .join(' ');
});

/**
 * Wait until the queue has nothing claimable, twice in a row.
 *
 * Two consecutive readings rather than one: a handler enqueues its follow-up in the same
 * transaction that completes it, so a single zero is almost certainly real — but the
 * second reading costs 50ms and removes the "almost".
 */
const untilDrained = Effect.gen(function* () {
  let consecutiveZeros = 0;
  while (consecutiveZeros < 2) {
    yield* Effect.sleep(Duration.millis(50));
    consecutiveZeros = (yield* claimableNow) === 0 ? consecutiveZeros + 1 : 0;
  }
});

/**
 * Run the dispatch loop until the queue is drained, then stop (the loop is
 * `Effect<never>`).
 *
 * This used to race the loop against a fixed `Effect.sleep(2)`. That is a global
 * wall-clock budget, not a completion condition: the loop polls every 50ms and each
 * scenario shells out to `psql`, so on a loaded machine two seconds stopped the dispatcher
 * mid-queue and the assertions then read a half-processed database. Three consecutive runs
 * failed in three different places. Draining on the queue's own state makes a green run
 * mean the work finished, and makes a red run a real failure rather than a slow machine.
 */
export const drain = Effect.gen(function* () {
  const queue = yield* Queue;
  const result = yield* Effect.race(
    queue.run({
      workerId: 'e2e',
      pollIntervalMillis: 50,
      batchSize: 10,
      visibilityTimeoutMillis: 300_000,
      retry: defaultRetryConfig,
    }),
    Effect.race(
      untilDrained.pipe(Effect.as('drained' as const)),
      Effect.sleep(Duration.seconds(DRAIN_DEADLINE_SECONDS)).pipe(
        Effect.as('deadline' as const),
      ),
    ),
  );
  if (result === 'deadline') {
    const left = yield* outstanding;
    return yield* Effect.die(
      new Error(
        `queue did not drain within ${DRAIN_DEADLINE_SECONDS.toString()}s; outstanding: ${left}`,
      ),
    );
  }
});

/** A retry policy whose first backoff outlasts any `runFor`: a failed attempt stays in
 * `retry` so the scenario can inspect what it left behind before letting it re-run. */
export const holdRetries: RetryConfig = {
  ...defaultRetryConfig,
  baseMillis: 600_000,
};

/** Make every `retry` message due now (the drain runbook's fast-forward). */
export const fastForwardRetries = (sql: SqlClient.SqlClient) =>
  sql`UPDATE messages SET "retryAt" = now() WHERE status = 'retry'`.pipe(
    Effect.asVoid,
  );

export const eq = async (
  query: EffectE2eContext['query'],
  sql: string,
  expected: string,
  message: string,
): Promise<void> => {
  assert.equal((await query(sql)).trim(), expected, message);
};

/** One database expectation: a query, its trimmed output, what it proves. */
export type Check = readonly [sql: string, expected: string, message: string];

/** Assert every check in order (the first mismatch fails the scenario). */
export const expectRows = async (
  query: EffectE2eContext['query'],
  checks: readonly Check[],
): Promise<void> => {
  for (const [sql, expected, message] of checks) {
    await eq(query, sql, expected, message);
  }
};

/**
 * A barrier inside a transaction: the code under test signals `reached` at the gate and
 * parks until the scenario opens `release`.
 */
export interface Gate {
  readonly reached: Deferred.Deferred<boolean>;
  readonly release: Deferred.Deferred<boolean>;
}

export const makeGate: Effect.Effect<Gate> = Effect.all({
  reached: Deferred.make<boolean>(),
  release: Deferred.make<boolean>(),
});

/** Signal the gate and wait until it is opened. */
export const pauseAt = (gate: Gate): Effect.Effect<void> =>
  Deferred.succeed(gate.reached, true).pipe(
    Effect.andThen(Deferred.await(gate.release)),
    Effect.asVoid,
  );

export const openGate = (gate: Gate): Effect.Effect<void> =>
  Deferred.succeed(gate.release, true).pipe(Effect.asVoid);

/** What a worker-runtime effect may require. */
export type WorkerContext =
  ManagedRuntime.ManagedRuntime.Context<WorkerRuntime>;

/** Something the worker runtime can run. */
export type OnWorker = <A, E>(
  effect: Effect.Effect<A, E, WorkerContext>,
) => Promise<A>;

/**
 * Run a scenario body against ONE worker runtime (registered handlers and injected seams
 * persist across its phases), so it can assert the database between phases. The
 * runtime is always disposed.
 */
export const withWorker = async (
  config: AppConfig,
  body: (run: OnWorker) => Promise<void>,
): Promise<void> => {
  const runtime = makeWorkerRuntime(config);
  try {
    await body((effect) => runtime.runPromise(effect));
  } finally {
    await runtime.dispose();
  }
};

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const P4W = 28 * DAY;

export interface SubSeed {
  readonly externalUserId: string;
  readonly end: Date;
  readonly status?: PaymentStatus;
  readonly method?: PaymentMethod;
  readonly token?: string | null;
  readonly period?: string;
  readonly currency?: number;
  readonly nextPaymentDate?: Date;
  readonly firstFailureAt?: Date | null;
  readonly retryAttempt?: number;
}

/** A recurring payment paid through `end`, P4W at 30000 by default. */
export const seedSub = (subs: PaymentRepo, s: SubSeed) =>
  subs.insert({
    externalUserId: s.externalUserId,
    amount: 30000,
    currency: s.currency ?? 0,
    method: s.method ?? PaymentMethod.Card,
    period: s.period ?? 'P4W',
    status: s.status ?? PaymentStatus.Active,
    recurring: true,
    currentPeriodStart: new Date(s.end.getTime() - P4W),
    currentPeriodEnd: s.end,
    nextPaymentDate: s.nextPaymentDate ?? s.end,
    recurringTokenRef: s.token === undefined ? 'tok_old' : s.token,
    firstFailureAt: s.firstFailureAt ?? null,
    retryAttempt: s.retryAttempt ?? 0,
  });

/** An injected database fault, typed like a real one so every retry path treats it so. */
export const injectedFault = (what: string) =>
  new SqlError.SqlError({ message: `injected fault: ${what}` });

/**
 * A `publish` that fails the first time it is asked to publish `name`, then delegates:
 * the fault lands after every earlier write of the surrounding transaction.
 */
export const failOncePublishing = (
  publish: (event: DomainEvent) => Effect.Effect<void, SqlError.SqlError>,
  name: DomainEvent['name'],
) => {
  let failed = false;
  return (event: DomainEvent): Effect.Effect<void, SqlError.SqlError> => {
    if (!failed && event.name === name) {
      failed = true;
      return Effect.fail(injectedFault(`publish ${name}`));
    }
    return publish(event);
  };
};

/** The production matcher chain (runtime.ts), built on `sql`. */
export const productionMatcher = (sql: SqlClient.SqlClient) =>
  makeCompositeMatcher([
    makeCardChangeMatcher(makeCheckoutRepo(sql)),
    makeCheckoutMatcher(
      makeCheckoutRepo(sql),
      makePaymentRepo(sql).findActiveRecurringByExternalUser,
    ),
    makeRecurringMatcher(makePaymentRepo(sql)),
  ]);

export interface SettlementSeams {
  /** Replaces the charge repo (e.g. to hold `lockMatchResult`). */
  readonly repo?: ChargeRepo;
  /** Replaces the payment repo the applier writes through (e.g. to hold `lockById`). */
  readonly payments?: PaymentRepo;
  readonly applier?: ChargeApplier;
  readonly publish?: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

/**
 * The `payment_event_received` handler exactly as the worker builds it, with one or more
 * seams swapped. Every default is the production piece on the scenario's database.
 */
export const settlementHandler = (seams: SettlementSeams = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* Outbox;
    return handleChargeEvent({
      repo: seams.repo ?? makeChargeRepo(sql),
      matcher: productionMatcher(sql),
      applier:
        seams.applier ??
        makeCheckoutApplier(
          seams.payments ?? makePaymentRepo(sql),
          makeCheckoutRepo(sql),
        ),
      publish: seams.publish ?? outbox.publish,
    });
  });

/** A charge as it sits on the queue (dates encoded), ready to hand to a handler. */
export const asPayload = (charge: Charge): unknown =>
  Schema.encodeSync(Charge)(charge);

/**
 * Wait until some backend of this database is blocked on a lock whose statement matches
 * `like` (pg_stat_activity), i.e. the contender has really reached its lock and parked.
 * A bounded poll on the server's own view, not a timing guess.
 */
export const awaitLockWait = (sql: SqlClient.SqlClient, like: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 500; i += 1) {
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.query LIKE ${like}
          AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted)
      `;
      if ((rows[0]?.n ?? 0) > 0) {
        return;
      }
      yield* Effect.sleep(Duration.millis(20));
    }
    return yield* Effect.die(`no backend ever waited on a lock for ${like}`);
  });

/** Collect every log message an effect writes (for the `SETTLEMENT_ANOMALY` markers). */
export const captureLogs = () => {
  const lines: string[] = [];
  const logger = Logger.make(({ message }) => {
    lines.push(
      Array.isArray(message) ? message.map(String).join(' ') : String(message),
    );
  });
  return {
    lines,
    layer: Logger.replace(Logger.defaultLogger, logger),
  };
};
