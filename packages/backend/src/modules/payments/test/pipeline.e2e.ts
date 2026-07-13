import assert from 'node:assert/strict';

import { Duration, Effect } from 'effect';

import type { AppConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox } from '@/modules/outbox/domain.js';
import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/payments/contracts.js';
import { PaymentPipeline } from '@/modules/payments/domain.js';
import { makeWorkerRuntime } from '@/runtime.js';

/**
 * Non-HTTP e2e scenarios: drive the worker pipeline directly against a real,
 * freshly-migrated Postgres (the runner in test/e2e/run.ts creates/migrates/drops
 * a throwaway database around each). This is the DB-integration proof for M1+M2 —
 * dedup, FOR UPDATE SKIP LOCKED, the CTE writes, and ON CONFLICT idempotency only
 * run for real here.
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

const IDEM_KEY = 'w4p:o1|PURCHASE|1700000000';

const testEvent: IncomingPaymentEvent = {
  source: 'test',
  idemKey: IDEM_KEY,
  externalRef: 'o1',
  externalUserId: null,
  amount: 30000,
  currency: 0, // UAH
  status: 'succeeded',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  payload: { note: 'e2e' },
};

/**
 * Register the two handlers, ingest the event twice (a duplicate receipt), then
 * run the dispatch loop until it drains (the loop is `Effect<never>`, so race it
 * against a short timer and stop).
 */
const drive = Effect.gen(function* () {
  const registry = yield* TaskRegistry;
  const outbox = yield* Outbox;
  const pipeline = yield* PaymentPipeline;
  yield* registry.register(PAYMENT_EVENT_RECEIVED, (p) =>
    pipeline.handleFromPayload(p),
  );
  yield* registry.register(DELIVER_EVENT, (p) => outbox.deliverFromPayload(p));

  yield* pipeline.ingest(testEvent);
  yield* pipeline.ingest(testEvent); // duplicate receipt

  const queue = yield* Queue;
  yield* Effect.race(
    queue.run({
      workerId: 'e2e',
      pollIntervalMillis: 50,
      batchSize: 10,
      visibilityTimeoutMillis: 300_000,
      retry: defaultRetryConfig,
    }),
    Effect.sleep(Duration.seconds(3)),
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

/** Assert the whole chain landed: dedup (AC2/AC3), quarantine (AC6), delivery. */
const assertChain = async (query: EffectE2eContext['query']): Promise<void> => {
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
    `SELECT count(*) FROM incoming_payment_events`,
    '1',
    'one incoming payment event recorded',
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
    `SELECT count(*) FROM domain_events WHERE name = 'unknown_payment_quarantined'`,
    '1',
    'quarantine emitted exactly one domain event',
  );
  await eq(
    query,
    `SELECT status FROM event_deliveries`,
    'delivered',
    'delivery reached the sink and was marked delivered',
  );
  await eq(
    query,
    `SELECT status FROM messages WHERE "messageType" = 'payment_event_received'`,
    'success',
    'processed message is terminally success',
  );
};

const quarantineAndDeliver: EffectScenario = {
  name: 'pipeline: unmatched payment is deduped, quarantined, and delivered',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(drive);
      await assertChain(query);
    } finally {
      await runtime.dispose();
    }
  },
};

export const effectScenarios: readonly EffectScenario[] = [
  quarantineAndDeliver,
];
