import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import { loadConfig } from '@/config.js';
import { runMigrations } from '@/infra/migrator.js';
import { makeWorkerRuntime } from '@/runtime.js';
import { bootWorker } from '@/worker-boot.js';

const config = loadConfig();

// Server-side migration hook: bring the schema up to date BEFORE serving traffic,
// in its own short-lived scope. Deliberately NOT inside `buildApp()`, so
// `buildApp()`-based unit tests stay connection-free (the app runtime is lazy).
try {
  await Effect.runPromise(runMigrations(config.database));
} catch (error) {
  console.error('startup migration failed:', error);
  process.exit(1);
}

// Optionally run the background queue worker IN THIS process, so one container both
// serves the API and drains the queue (dispatch loop + gated poller/scheduler). It
// runs on its own worker runtime, forked (not awaited) to run alongside the HTTP
// server; migrations above have already prepared the schema. `WORKER_ENABLED=false`
// (default) keeps them split — the worker then runs only as `dist/worker.js`.
if (config.worker.enabled) {
  makeWorkerRuntime(config).runFork(bootWorker(config));
}

const app = await buildApp();

try {
  await app.listen({ host: app.appConfig.host, port: app.appConfig.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
