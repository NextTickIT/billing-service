import { hostname } from 'node:os';

import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

import { loadConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import {
  TaskRegistry,
  type TaskRegistryService,
} from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox, type OutboxService } from '@/modules/outbox/domain.js';
import {
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@/modules/charge/contracts.js';
import {
  ChargePipeline,
  type ChargePipelineService,
} from '@/modules/charge/domain.js';
import { runScheduler } from '@/modules/billing/scheduler.js';
import { cancelNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_CANCEL } from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { WayForPay } from '@/modules/wayforpay/client.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { runPoller } from '@/modules/wayforpay/poller.js';
import { makeWorkerRuntime } from '@/runtime.js';

/**
 * Background worker process. Boots the DB-backed worker runtime, registers the
 * queue handlers, forks the long-lived sources (poller, scheduler — each gated off
 * until production credentials exist), and runs the dispatch loop (docs/09).
 * Migrations are applied by the server/`db:migrate`, not here.
 */
const config = loadConfig();

type Ingest = ChargePipelineService['ingest'];

const registerHandlers = (
  registry: TaskRegistryService,
  outbox: OutboxService,
  pipeline: ChargePipelineService,
) =>
  Effect.gen(function* () {
    yield* registry.register(PAYMENT_EVENT_RECEIVED, (payload) =>
      pipeline.handleFromPayload(payload),
    );
    yield* registry.register(PAYMENT_REBIND, (payload) =>
      pipeline.rebindFromPayload(payload),
    );
    yield* registry.register(DELIVER_EVENT, (payload) =>
      outbox.deliverFromPayload(payload),
    );
    yield* registry.register(PAYMENT_CANCEL, cancelNotify(outbox.publish));
  });

/** Fork the WayForPay migration poller (docs/15) if enabled. */
const startPoller = (ingest: Ingest) =>
  Effect.gen(function* () {
    if (!config.wayforpay.pollerEnabled) {
      return;
    }
    const client = yield* WayForPay;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forkDaemon(
      runPoller(
        { client, ingest, state: makePollerStateRepo(sql) },
        {
          account: config.wayforpay.merchantAccount,
          pollIntervalSeconds: config.wayforpay.pollIntervalSeconds,
          windowOverlapSeconds: config.wayforpay.windowOverlapSeconds,
          maxWindowSeconds: config.wayforpay.maxWindowSeconds,
        },
      ),
    );
    yield* Effect.logInfo('w4p migration poller started');
  });

/** Fork the recurring-charge scheduler (FR-004) if enabled. */
const startScheduler = (ingest: Ingest, publish: OutboxService['publish']) =>
  Effect.gen(function* () {
    if (!config.scheduler.enabled) {
      return;
    }
    const client = yield* WayForPay;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forkDaemon(
      runScheduler(
        { subs: makePaymentRepo(sql), client, ingest, publish },
        {
          intervalSeconds: config.scheduler.intervalSeconds,
          batchSize: config.scheduler.batchSize,
        },
      ),
    );
    yield* Effect.logInfo('recurring scheduler started');
  });

const runtime = makeWorkerRuntime(config);

// Distinct per process, so `lockedBy` and the reaper can tell workers apart.
const workerId = `${hostname()}:${process.pid.toString()}`;

await runtime.runPromise(
  Effect.gen(function* () {
    yield* Effect.logInfo('worker started').pipe(
      Effect.annotateLogs('workerId', workerId),
    );
    const registry = yield* TaskRegistry;
    const outbox = yield* Outbox;
    const pipeline = yield* ChargePipeline;
    yield* registerHandlers(registry, outbox, pipeline);
    yield* startPoller(pipeline.ingest);
    yield* startScheduler(pipeline.ingest, outbox.publish);
    const queue = yield* Queue;
    yield* queue.run({
      workerId,
      pollIntervalMillis: config.queue.pollIntervalMillis,
      batchSize: config.queue.batchSize,
      visibilityTimeoutMillis: config.queue.visibilityTimeoutMillis,
      retry: { ...defaultRetryConfig, maxAttempts: config.queue.maxAttempts },
    });
  }),
);
