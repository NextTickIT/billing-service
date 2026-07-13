import { hostname } from 'node:os';

import { Effect } from 'effect';

import { loadConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
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
