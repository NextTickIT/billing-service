import { hostname } from 'node:os';

import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

import type { AppConfig } from '@/config.js';
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
import {
  cancelNotify,
  deferNotify,
  lapseNotify,
  reactivateNotify,
} from '@/modules/payment/cancel.js';
import {
  PAYMENT_CANCEL,
  PAYMENT_DEFER,
  PAYMENT_LAPSE,
  PAYMENT_REACTIVATE,
} from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { enqueue } from '@/infra/queue/store.js';
import { WayForPay } from '@/modules/wayforpay/client.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { runPoller } from '@/modules/wayforpay/poller.js';

/**
 * Worker boot, factored out of the entrypoint so it can run in EITHER process:
 * its own OS process (`worker.ts`, foreground) or inside the HTTP server
 * (`main.ts`, forked) when `WORKER_ENABLED=true`. It registers the queue handlers,
 * forks the long-lived sources (poller, scheduler — each still gated by its own
 * flag), then runs the durable queue dispatch loop. Kept free of top-level side
 * effects so importing it never starts anything.
 */

type Ingest = ChargePipelineService['ingest'];

const registerHandlers = (
  registry: TaskRegistryService,
  outbox: OutboxService,
  pipeline: ChargePipelineService,
  sql: SqlClient.SqlClient,
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
    yield* registry.register(
      PAYMENT_REACTIVATE,
      reactivateNotify(outbox.publish),
    );
    yield* registry.register(PAYMENT_DEFER, deferNotify(outbox.publish));
    yield* registry.register(
      PAYMENT_LAPSE,
      lapseNotify(makePaymentRepo(sql), outbox.publish),
    );
  });

/** Fork the WayForPay migration poller (docs/15) if enabled. */
const startPoller = (config: AppConfig, ingest: Ingest) =>
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
const startScheduler = (
  config: AppConfig,
  ingest: Ingest,
  publish: OutboxService['publish'],
) =>
  Effect.gen(function* () {
    if (!config.scheduler.enabled) {
      return;
    }
    const client = yield* WayForPay;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forkDaemon(
      runScheduler(
        {
          subs: makePaymentRepo(sql),
          client,
          ingest,
          publish,
          lapse: (sub) =>
            enqueue(sql)({
              messageType: PAYMENT_LAPSE,
              idemKey: `lapse:${sub.id}`,
              payload: {
                paymentId: sub.id,
                externalUserId: sub.externalUserId,
              },
            }).pipe(Effect.asVoid),
        },
        {
          intervalSeconds: config.scheduler.intervalSeconds,
          batchSize: config.scheduler.batchSize,
        },
      ),
    );
    yield* Effect.logInfo('recurring scheduler started');
  });

/**
 * Register handlers, start the gated sources, then run the queue dispatch loop.
 * The returned effect never completes (the loop runs forever): the standalone
 * worker awaits it; the server forks it.
 */
export const bootWorker = (config: AppConfig) =>
  Effect.gen(function* () {
    const workerId = `${hostname()}:${process.pid.toString()}`;
    yield* Effect.logInfo('worker started').pipe(
      Effect.annotateLogs('workerId', workerId),
    );
    const registry = yield* TaskRegistry;
    const outbox = yield* Outbox;
    const pipeline = yield* ChargePipeline;
    const sql = yield* SqlClient.SqlClient;
    yield* registerHandlers(registry, outbox, pipeline, sql);
    yield* startPoller(config, pipeline.ingest);
    yield* startScheduler(config, pipeline.ingest, outbox.publish);
    const queue = yield* Queue;
    return yield* queue.run({
      workerId,
      pollIntervalMillis: config.queue.pollIntervalMillis,
      batchSize: config.queue.batchSize,
      visibilityTimeoutMillis: config.queue.visibilityTimeoutMillis,
      retry: { ...defaultRetryConfig, maxAttempts: config.queue.maxAttempts },
    });
  });
