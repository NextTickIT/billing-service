import { Effect } from 'effect';

import { loadConfig } from '@/config.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import { makeWorkerRuntime } from '@/runtime.js';
import { bootWorker } from '@/worker-boot.js';

/**
 * Standalone background worker process. Boots the DB-backed worker runtime and runs
 * the queue dispatch loop (+ gated poller/scheduler) in the foreground — the loop
 * never returns, so the process stays alive. The same boot runs inside the HTTP
 * server when `WORKER_ENABLED=true` (see `main.ts`); this entrypoint is for running
 * the worker as its own OS process. Migrations are applied by the server/`db:migrate`.
 *
 * With a command argument it runs that one-off operator command on the same runtime
 * instead, prints its result and exits (docs/34).
 */
const REPROCESS_REFUNDED = 'charges:reprocess-refunded';

const config = loadConfig();
const runtime = makeWorkerRuntime(config);
const command = process.argv[2];

if (command === undefined) {
  await runtime.runPromise(bootWorker(config));
} else if (command === REPROCESS_REFUNDED) {
  const report = await runtime.runPromise(
    Effect.flatMap(ChargePipeline, (pipeline) => pipeline.reprocessRefunded()),
  );
  console.log(`${REPROCESS_REFUNDED} ${JSON.stringify(report)}`);
  await runtime.dispose();
} else {
  console.error(`unknown worker command: ${command}`);
  process.exit(1);
}
