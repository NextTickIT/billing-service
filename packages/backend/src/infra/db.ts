import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted } from 'effect';

import type { DatabaseConfig } from '@/config.js';

/**
 * Database — data-access seam. The skeleton provides a trivial health check so
 * the app boots without a live DB. `makePgClientLayer` builds a real
 * @effect/sql-pg connection Layer for when queries are added; it is provided
 * here but intentionally NOT wired into the default runtime (no queries yet).
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

/** Real Postgres connection Layer (see @effect/sql-pg). Not activated yet. */
export const makePgClientLayer = (config: DatabaseConfig) =>
  PgClient.layer({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: Redacted.make(config.password),
  });
