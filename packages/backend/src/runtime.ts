import { Layer, ManagedRuntime } from 'effect';

import type { AppConfig } from '@/config.js';
import { DatabaseLive, SqlLive } from '@/infra/db.js';
import { HasherLive } from '@/infra/hasher.js';
import { QueueLive } from '@/infra/queue/service.js';
import { LoggingSinkLive } from '@/infra/sinks.js';
import { TaskRegistryLive } from '@/infra/task-registry.js';
import { makeAuthConfig } from '@/modules/auth/domain.js';
import { AuthRepoLive } from '@/modules/auth/data-access.js';
import { OutboxLive } from '@/modules/outbox/domain.js';

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
    // `provideMerge` (not `provide`) so `SqlClient` stays in the runtime's
    // context — the `/health` readiness probe runs `SELECT 1` on it directly.
    AuthRepoLive.pipe(Layer.provideMerge(SqlLive(config.database))),
  );

export const makeDbRuntime = (config: AppConfig) =>
  ManagedRuntime.make(makeAppDbLayer(config));

export type AppDbRuntime = ReturnType<typeof makeDbRuntime>;

/**
 * Worker runtime — the background process (src/worker.ts). DB-backed: the `Queue`
 * dispatcher and `Outbox` need `SqlClient`, the queue reads the `TaskRegistry` for
 * the handler set, and the outbox fans out to the `Sinks`. Built eagerly on worker
 * start (no hermetic-health constraint off the request path). Layering: base
 * services -> Queue (needs sql + registry) -> Outbox (needs sql + sinks + queue).
 */
export const makeWorkerLayer = (config: AppConfig) => {
  const base = Layer.mergeAll(
    TaskRegistryLive,
    LoggingSinkLive,
    SqlLive(config.database),
  );
  const withQueue = Layer.provideMerge(QueueLive, base);
  return Layer.provideMerge(OutboxLive, withQueue);
};

export const makeWorkerRuntime = (config: AppConfig) =>
  ManagedRuntime.make(makeWorkerLayer(config));

export type WorkerRuntime = ReturnType<typeof makeWorkerRuntime>;
