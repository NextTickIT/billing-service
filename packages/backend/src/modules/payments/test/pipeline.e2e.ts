import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import { Duration, Effect } from 'effect';

import type { AppConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import { enqueue } from '@/infra/queue/store.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox } from '@/modules/outbox/domain.js';
import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import {
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@/modules/payments/contracts.js';
import { makePaymentsRepo } from '@/modules/payments/data-access.js';
import { PaymentPipeline } from '@/modules/payments/domain.js';
import { normalizeCallback } from '@/modules/checkout/callback.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import type { W4pTransaction } from '@/modules/wayforpay/contracts.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { pollTick } from '@/modules/wayforpay/poller.js';
import { makeWorkerRuntime } from '@/runtime.js';

/**
 * Non-HTTP e2e scenarios: drive the worker pipeline directly against a real,
 * freshly-migrated Postgres (the runner in test/e2e/run.ts creates/migrates/drops
 * a throwaway database around each). This is the DB-integration proof for M1+M2 —
 * dedup, FOR UPDATE SKIP LOCKED, the CTE writes, ON CONFLICT idempotency, and the
 * bind/rebind SQL only run for real here.
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

const event = (idemKey: string): IncomingPaymentEvent => ({
  source: 'test',
  idemKey,
  externalRef: 'o1',
  externalUserId: null,
  amount: 30000,
  currency: 0, // UAH
  status: 'succeeded',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  payload: { note: 'e2e' },
});

/** Register the three worker handlers. */
const registerHandlers = Effect.gen(function* () {
  const registry = yield* TaskRegistry;
  const outbox = yield* Outbox;
  const pipeline = yield* PaymentPipeline;
  yield* registry.register(PAYMENT_EVENT_RECEIVED, (p) =>
    pipeline.handleFromPayload(p),
  );
  yield* registry.register(PAYMENT_REBIND, (p) =>
    pipeline.rebindFromPayload(p),
  );
  yield* registry.register(DELIVER_EVENT, (p) => outbox.deliverFromPayload(p));
});

/** Run the dispatch loop for `seconds`, then stop (the loop is `Effect<never>`). */
const runFor = (seconds: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue;
    yield* Effect.race(
      queue.run({
        workerId: 'e2e',
        pollIntervalMillis: 50,
        batchSize: 10,
        visibilityTimeoutMillis: 300_000,
        retry: defaultRetryConfig,
      }),
      Effect.sleep(Duration.seconds(seconds)),
    );
  });

const eq = async (
  query: EffectE2eContext['query'],
  sql: string,
  expected: string,
  message: string,
): Promise<void> => {
  assert.equal((await query(sql)).trim(), expected, message);
};

const IDEM_KEY = 'w4p:o1|PURCHASE|1700000000';

/** Ingest the same event twice, drain, and assert dedup + quarantine + delivery. */
const driveQuarantine = Effect.gen(function* () {
  yield* registerHandlers;
  const pipeline = yield* PaymentPipeline;
  yield* pipeline.ingest(event(IDEM_KEY));
  yield* pipeline.ingest(event(IDEM_KEY)); // duplicate receipt
  yield* runFor(3);
});

const assertQuarantine = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM raw_events WHERE "idemKey" = '${IDEM_KEY}'`,
    '2',
    'both receipts appended to raw_events (AC3)',
  );
  await eq(
    query,
    `SELECT count(*) FROM messages WHERE "messageType" = 'payment_event_received'`,
    '1',
    'duplicate deduped to a single message (AC2)',
  );
  await eq(
    query,
    `SELECT count(*) FROM payments`,
    '0',
    'no payment when unmatched',
  );
  await eq(
    query,
    `SELECT count(*) FROM quarantine_records WHERE status = 'open'`,
    '1',
    'unmatched event quarantined (AC6)',
  );
  await eq(
    query,
    `SELECT status FROM event_deliveries`,
    'delivered',
    'delivery reached the sink and was marked delivered',
  );
};

const quarantineAndDeliver: EffectScenario = {
  name: 'pipeline: unmatched payment is deduped, quarantined, and delivered',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveQuarantine);
      await assertQuarantine(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const BIND_KEY = 'w4p:o2|PURCHASE|1700000500';

/** Quarantine an event, then bind it (audit + enqueue rebind) via the real repo. */
const driveBind = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const repo = makePaymentsRepo(sql);
  const pipeline = yield* PaymentPipeline;

  yield* pipeline.ingest(event(BIND_KEY));
  yield* runFor(2); // quarantine + deliver

  const open = yield* repo.listOpenQuarantine();
  const record = open[0];
  if (record === undefined) {
    return;
  }
  yield* repo.insertAudit({
    actor: 'Operator',
    action: 'bind_quarantine',
    targetType: 'quarantine',
    targetId: record.quarantineId,
    detail: { externalUserId: 'sp:bound' },
  });
  yield* enqueue(sql)({
    messageType: PAYMENT_REBIND,
    idemKey: `rebind:${record.quarantineId}`,
    payload: {
      incomingEventId: record.incomingEventId,
      quarantineId: record.quarantineId,
      externalUserId: 'sp:bound',
      subscriptionId: null,
      period: 'P1M',
      method: 0,
    },
  });
  yield* runFor(2); // reprocess + deliver
});

const assertBind = async (query: EffectE2eContext['query']): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM payments WHERE "subscriptionId" IS NULL`,
    '1',
    'bound payment recorded without a subscription yet',
  );
  await eq(
    query,
    `SELECT status FROM quarantine_records`,
    'resolved',
    'quarantine resolved after bind (AC6)',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'payment_succeeded'`,
    '1',
    'bind emitted payment_succeeded',
  );
  await eq(
    query,
    `SELECT count(*) FROM audit_log WHERE action = 'bind_quarantine'`,
    '1',
    'operator bind was audited',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both the quarantine and the bound payment were delivered',
  );
};

const bindReprocesses: EffectScenario = {
  name: 'support: operator bind reprocesses a quarantine into a payment (FR-009)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveBind);
      await assertBind(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const journal: readonly W4pTransaction[] = [
  {
    transactionType: 'PURCHASE',
    orderReference: 'p1',
    createdDate: '1700000000',
    amount: '10.00',
    currency: 'UAH',
    transactionStatus: 'Approved',
  },
  {
    transactionType: 'PURCHASE',
    orderReference: 'p2',
    createdDate: '1700000100',
    amount: '20.00',
    currency: 'UAH',
    transactionStatus: 'Approved',
  },
  {
    transactionType: 'SETTLE',
    orderReference: 's1',
    createdDate: '1700000200',
  },
];

/** Poll a canned journal (fake client, no network), then drain the pipeline. */
const drivePoller = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const pipeline = yield* PaymentPipeline;
  yield* pollTick(
    {
      client: { transactionList: () => Effect.succeed(journal) },
      ingest: pipeline.ingest,
      state: makePollerStateRepo(sql),
    },
    {
      account: 'acc',
      pollIntervalSeconds: 120,
      windowOverlapSeconds: 900,
      maxWindowSeconds: 21600,
    },
  );
  yield* runFor(2);
});

const assertPoller = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM incoming_payment_events`,
    '2',
    'two payment rows ingested; SETTLE skipped',
  );
  await eq(
    query,
    `SELECT count(*) FROM w4p_poller_state WHERE account = 'acc'`,
    '1',
    'watermark persisted for the account',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both quarantine events delivered',
  );
};

const pollerIngestsJournal: EffectScenario = {
  name: 'poller: journal rows are ingested through the pipeline (FR-008)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(drivePoller);
      await assertPoller(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const CHK_ID = 'chk_e2e';

/** Seed a checkout session, then feed its (normalized) success callback through
 * the pipeline — the checkout matcher + applier turn it into a subscription. */
const driveCheckout = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  yield* makeCheckoutRepo(sql).insert({
    id: CHK_ID,
    externalUserId: 'sp:checkout',
    amount: 30000,
    currency: 0,
    period: 'P1M',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  const pipeline = yield* PaymentPipeline;
  yield* pipeline.ingest(
    normalizeCallback({
      orderReference: CHK_ID,
      amount: '300',
      currency: 'UAH',
      transactionStatus: 'Approved',
      recToken: 'tok_e2e',
      createdDate: '1700000000',
    }),
  );
  yield* runFor(2);
});

const assertCheckout = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM subscriptions WHERE status = 0`,
    '1',
    'an active subscription was created (AC5)',
  );
  await eq(
    query,
    `SELECT "recurringTokenRef" FROM subscriptions`,
    'tok_e2e',
    'the card token was stored (AC5)',
  );
  await eq(
    query,
    `SELECT "externalUserId" FROM subscriptions`,
    'sp:checkout',
    'external user carried through',
  );
  await eq(
    query,
    `SELECT status FROM checkout_sessions WHERE id = '${CHK_ID}'`,
    '2',
    'the session was marked completed',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'subscription_created'`,
    '1',
    'subscription_created emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'payment_succeeded'`,
    '1',
    'payment_succeeded emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both events delivered',
  );
};

const checkoutCreatesSubscription: EffectScenario = {
  name: 'checkout: a successful payment creates a subscription + events (AC5)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCheckout);
      await assertCheckout(query);
    } finally {
      await runtime.dispose();
    }
  },
};

export const effectScenarios: readonly EffectScenario[] = [
  quarantineAndDeliver,
  bindReprocesses,
  pollerIngestsJournal,
  checkoutCreatesSubscription,
];
