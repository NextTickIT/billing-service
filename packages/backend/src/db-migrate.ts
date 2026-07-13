import { Effect } from 'effect';

import { loadConfig } from '@/config.js';
import { runMigrations } from '@/infra/migrator.js';

/**
 * Standalone migration entrypoint (`npm run db:migrate`). Reuses the exact same
 * `runMigrations` as the server startup hook (single migration authority) and
 * exits non-zero on failure so CI/scripts can gate on it.
 */
try {
  const applied = await Effect.runPromise(runMigrations(loadConfig().database));
  console.log(`migrations up to date (${applied.length.toString()} applied)`);
} catch (error) {
  console.error('migration failed:', error);
  process.exit(1);
}
