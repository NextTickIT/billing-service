import { fileURLToPath } from 'node:url';

import { NodeContext } from '@effect/platform-node';
import { SqlClient } from '@effect/sql';
import { PgClient, PgMigrator } from '@effect/sql-pg';
import { MigrationError } from '@effect/sql/Migrator';
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

/** A migration's identity: the `{id}_{name}` of its file, or of its applied row. */
export interface MigrationIdentity {
  readonly id: number;
  readonly name: string;
}

/**
 * Applied migrations with no file of the same id AND name. The migrator itself only
 * compares ids against the latest applied one (`id <= latest` is skipped, with no name
 * check), so a renumbered or rebased migration line would either collide or be silently
 * skipped, leaving its columns missing. Boot refuses instead.
 */
export const unmatchedApplied = (
  applied: readonly MigrationIdentity[],
  files: readonly MigrationIdentity[],
): readonly MigrationIdentity[] =>
  applied.filter(
    (row) => !files.some((f) => f.id === row.id && f.name === row.name),
  );

const loader = fromFileSystem(migrationsDir);

/**
 * Fail boot when the database has applied a migration this image does not ship under
 * the same id and name — e.g. a DB that ran another branch's 0021. A fresh database has
 * no bookkeeping table yet and passes.
 */
const assertAppliedMatchFiles = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql<{ readonly present: boolean }>`
    SELECT to_regclass('effect_sql_migrations') IS NOT NULL AS present
  `;
  if (table?.present !== true) return;
  const applied = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
  const files = (yield* loader).map(([id, name]) => ({ id, name }));
  const unmatched = unmatchedApplied(
    applied.map((row) => ({ id: row.migration_id, name: row.name })),
    files,
  );
  if (unmatched.length > 0) {
    const list = unmatched.map((m) => `${String(m.id)}_${m.name}`).join(', ');
    return yield* new MigrationError({
      reason: 'failed',
      message: `Applied migrations have no matching file (same id and name): ${list}. The database was migrated by a different migration line; reset it or renumber before booting.`,
    });
  }
});

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
    ssl: config.ssl,
  });

/**
 * Apply all pending migrations to `config`'s database. Idempotent — the
 * migrator's applied-tracking table skips already-applied migrations, so a
 * second run applies nothing. This is the single migration authority, reused by
 * the server startup hook (main.ts) and `npm run db:migrate` (db-migrate.ts).
 * It first refuses a database whose applied migrations this image does not ship.
 * `NodeContext.layer` supplies FileSystem + Path for the loader; the short-lived
 * connection layer is built and disposed around the run.
 */
export const runMigrations = (config: DatabaseConfig) =>
  assertAppliedMatchFiles.pipe(
    Effect.zipRight(PgMigrator.run({ loader })),
    Effect.provide(Layer.merge(NodeContext.layer, migrationSqlLayer(config))),
  );
