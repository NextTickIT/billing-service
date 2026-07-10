import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import { loadConfig } from '@/config.js';
import { runMigrations } from '@/infra/migrator.js';

const config = loadConfig();

// Server-side migration hook: bring the schema up to date BEFORE serving
// traffic, in its own short-lived scope. Deliberately NOT inside `buildApp()`,
// so `buildApp()`-based unit tests and `GET /health` stay DB-less.
try {
  await Effect.runPromise(runMigrations(config.database));
} catch (error) {
  console.error('startup migration failed:', error);
  process.exit(1);
}

const app = await buildApp();

try {
  await app.listen({ host: app.appConfig.host, port: app.appConfig.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
