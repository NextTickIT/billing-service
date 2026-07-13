import { fileURLToPath } from 'node:url';

import { NodeContext } from '@effect/platform-node';
import { PgClient, PgMigrator } from '@effect/sql-pg';
import { fromFileSystem } from '@effect/sql/Migrator/FileSystem';
import { Effect, Layer, Redacted } from 'effect';

import type { DatabaseConfig } from '@/config.js';

/**
 * Absolute path to the migrations directory. Migrations live under `src` (as
 * typed Effect modules — the migrator loads `.ts`/`.js`, not `.sql`), so tsc
 * compiles them into `dist/migrations`. `../migrations` resolves to
 * `src/migrations` under `tsx` and `dist/migrations` under `node dist` — same
 * relative path, right files in each, no copy step.
 */
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Plain connection for migrations — deliberately WITHOUT the app's
 * camel<->snake name transforms, so raw DDL and the migrator's own bookkeeping
 * table see identifiers exactly as written.
 */
const migrationSqlLayer = (config: DatabaseConfig) =>
  PgClient.layer({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: Redacted.make(config.password),
  });

/**
 * Apply all pending migrations to `config`'s database. Idempotent — the
 * migrator's applied-tracking table skips already-applied migrations, so a
 * second run applies nothing. This is the single migration authority, reused by
 * the server startup hook (main.ts) and `npm run db:migrate` (db-migrate.ts).
 * `NodeContext.layer` supplies FileSystem + Path for the loader; the short-lived
 * connection layer is built and disposed around the run.
 */
export const runMigrations = (config: DatabaseConfig) =>
  PgMigrator.run({ loader: fromFileSystem(migrationsDir) }).pipe(
    Effect.provide(Layer.merge(NodeContext.layer, migrationSqlLayer(config))),
  );
