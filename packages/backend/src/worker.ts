import { hostname } from 'node:os';

import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

import { loadConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox } from '@/modules/outbox/domain.js';
import {
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@/modules/payments/contracts.js';
import { PaymentPipeline } from '@/modules/payments/domain.js';
import { WayForPay } from '@/modules/wayforpay/client.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { runPoller } from '@/modules/wayforpay/poller.js';
import { makeWorkerRuntime } from '@/runtime.js';

/**
 * Background worker process. Boots the DB-backed worker runtime and runs the
 * durable-queue dispatch loop (docs/09). Modules register their handlers on the
 * TaskRegistry; until any do, the loop idles (claims only known message types).
 * Migrations are applied by the server/`db:migrate`, not here.
 */
const config = loadConfig();
const runtime = makeWorkerRuntime(config);

// Distinct per process, so `lockedBy` and the reaper can tell workers apart.
const workerId = `${hostname()}:${process.pid.toString()}`;

await runtime.runPromise(
  Effect.gen(function* () {
    yield* Effect.logInfo('worker started').pipe(
      Effect.annotateLogs('workerId', workerId),
    );
    // Register worker-side handlers, then run the dispatch loop.
    const registry = yield* TaskRegistry;
    const outbox = yield* Outbox;
    const pipeline = yield* PaymentPipeline;
    yield* registry.register(PAYMENT_EVENT_RECEIVED, (payload) =>
      pipeline.handleFromPayload(payload),
    );
    yield* registry.register(PAYMENT_REBIND, (payload) =>
      pipeline.rebindFromPayload(payload),
    );
    yield* registry.register(DELIVER_EVENT, (payload) =>
      outbox.deliverFromPayload(payload),
    );

    // The migration poller runs alongside the dispatcher (docs/15). It is a
    // separate long-lived source and must not block queue processing, so it is
    // forked; gated off until production WayForPay credentials are provisioned.
    if (config.wayforpay.pollerEnabled) {
      const client = yield* WayForPay;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.forkDaemon(
        runPoller(
          { client, ingest: pipeline.ingest, state: makePollerStateRepo(sql) },
          {
            account: config.wayforpay.merchantAccount,
            pollIntervalSeconds: config.wayforpay.pollIntervalSeconds,
            windowOverlapSeconds: config.wayforpay.windowOverlapSeconds,
            maxWindowSeconds: config.wayforpay.maxWindowSeconds,
          },
        ),
      );
      yield* Effect.logInfo('w4p migration poller started');
    }

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
