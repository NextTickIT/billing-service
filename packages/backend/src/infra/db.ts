import { PgClient } from '@effect/sql-pg';
import { Redacted } from 'effect';

import type { DatabaseConfig } from '@/config.js';

/**
 * Real Postgres connection Layer — provides both `PgClient` and `SqlClient`.
 * `PgClient.layer` connects EAGERLY (it runs `SELECT 1` at layer-build time) and
 * `ManagedRuntime` builds the layer graph on first use, so the application runtime
 * opens no connection until its first `run*` (an auth route or the `/health`
 * probe) — `buildApp()` and connection-free unit tests stay hermetic. NO name
 * transforms: columns are stored under the exact shared-schema field names
 * (camelCase, so DDL/queries double-quote them), so a row is the entity shape
 * verbatim across db, backend, and frontend — the single-source-of-truth rule.
 */
export const SqlLive = (config: DatabaseConfig) =>
  PgClient.layer({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: Redacted.make(config.password),
    ssl: config.ssl,
  });
