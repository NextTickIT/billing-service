import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted } from 'effect';

import type { DatabaseConfig } from '@/config.js';

/**
 * Database — data-access seam. `Database` is a trivial health service so the app
 * boots without a live DB (health stays hermetic). `SqlLive` is the REAL
 * @effect/sql-pg connection Layer used by modules that run queries.
 *
 * IMPORTANT: `PgClient.layer` connects EAGERLY (it runs `SELECT 1` at
 * layer-build time) and `ManagedRuntime` builds the whole layer graph on first
 * use. So `SqlLive` must NEVER be merged into the DB-less `AppLayer` behind
 * `GET /health`; it lives only in the separate `AppDbLayer` / `dbRuntime`
 * (see runtime.ts) and the short-lived migration runtime (main.ts).
 */
export interface DatabaseService {
  readonly healthcheck: () => Effect.Effect<boolean>;
}

export class Database extends Context.Tag('Database')<
  Database,
  DatabaseService
>() {}

export const DatabaseLive = Layer.succeed(Database, {
  healthcheck: () => Effect.succeed(true),
});

/**
 * Real Postgres connection Layer — provides both `PgClient` and `SqlClient`.
 * NO name transforms: columns are stored under the exact same names as the
 * shared schema fields (camelCase, so DDL/queries double-quote them), so a row
 * is the entity shape verbatim. Db, backend, and frontend share one shape with
 * no remap — the single-source-of-truth rule.
 */
export const SqlLive = (config: DatabaseConfig) =>
  PgClient.layer({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: Redacted.make(config.password),
  });
