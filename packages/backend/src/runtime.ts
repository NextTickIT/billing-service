import { Layer, ManagedRuntime } from 'effect';

import type { AppConfig } from '@/config.js';
import { DatabaseLive, SqlLive } from '@/infra/db.js';
import { HasherLive } from '@/infra/hasher.js';
import { TaskRegistryLive } from '@/infra/task-registry.js';
import { makeAuthConfig } from '@/modules/auth/config.js';
import { AuthRepoLive } from '@/modules/auth/data-access.js';

/**
 * Two runtimes, by design (see docs/13 ADR):
 *
 * - `AppLayer` / `AppRuntime` — DB-LESS (health + task registry). Because
 *   `PgClient.layer` connects eagerly and `ManagedRuntime` builds the whole
 *   layer on first use, `SqlLive` must never appear here, or `GET /health`
 *   would require Postgres.
 * - `AppDbLayer` / `AppDbRuntime` — the DB-backed runtime (Hasher + AuthConfig +
 *   AuthRepo ⊂ SqlLive), used only by auth routes. Its `ManagedRuntime` is lazy:
 *   constructing it opens no connection; the pool is built on the first auth
 *   `run*`, keeping `buildApp()`/health hermetic.
 */
export const AppLayer = Layer.mergeAll(DatabaseLive, TaskRegistryLive);

export type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<typeof AppLayer>,
  never
>;

export const makeRuntime = (): AppRuntime => ManagedRuntime.make(AppLayer);

/** DB-backed layer for the auth module — parameterized by config because
 * `PgClient` needs connection params and the domain needs admin token + TTL. */
export const makeAppDbLayer = (config: AppConfig) =>
  Layer.mergeAll(
    HasherLive,
    makeAuthConfig({
      adminToken: config.adminToken,
      sessionTtlSeconds: config.sessionTtlSeconds,
    }),
    AuthRepoLive.pipe(Layer.provide(SqlLive(config.database))),
  );

export const makeDbRuntime = (config: AppConfig) =>
  ManagedRuntime.make(makeAppDbLayer(config));

export type AppDbRuntime = ReturnType<typeof makeDbRuntime>;
