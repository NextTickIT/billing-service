import { loadConfig } from '@/config.js';
import { makeWorkerRuntime } from '@/runtime.js';
import { bootWorker } from '@/worker-boot.js';

/**
 * Standalone background worker process. Boots the DB-backed worker runtime and runs
 * the queue dispatch loop (+ gated poller/scheduler) in the foreground — the loop
 * never returns, so the process stays alive. The same boot runs inside the HTTP
 * server when `WORKER_ENABLED=true` (see `main.ts`); this entrypoint is for running
 * the worker as its own OS process. Migrations are applied by the server/`db:migrate`.
 */
const config = loadConfig();
const runtime = makeWorkerRuntime(config);

await runtime.runPromise(bootWorker(config));
