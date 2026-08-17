import { SqlClient } from '@effect/sql';
import { Clock, Effect, Layer, Ref } from 'effect';

import { makeRateLimiter } from '@/infra/rate-limiter.js';
import { Sinks, type SinkConnector } from '@/infra/sinks.js';
import { buildConnectors, type ConnectorDeps } from '@/modules/sinks/domain.js';
import { makeSinksRepo } from '@/modules/sinks/data-access.js';

/**
 * DB-backed `Sinks` service (docs/21 §4.4). `all()` is called by the outbox at
 * publish and on every delivery retry, so reading config from the DB makes operator
 * changes take effect with no worker restart. A short-TTL cache keeps the hot path
 * off the DB; the `fetch` + rate limiter are built ONCE and reused across rebuilds
 * (only `{token, flows}` change), so a rebuild never leaks a limiter. A config-read
 * error is a defect (`orDie`) so the enclosing publish/deliver retries rather than
 * silently delivering to zero sinks.
 */
export interface SinksLiveConfig {
  readonly cacheTtlMillis: number;
  readonly sendpulse: {
    readonly apiUrl: string;
    readonly rateLimitRps: number;
  };
}

interface CacheState {
  readonly builtAt: number;
  readonly connectors: readonly SinkConnector[];
}

export const SinksLive = (
  config: SinksLiveConfig,
): Layer.Layer<Sinks, never, SqlClient.SqlClient> =>
  Layer.effect(
    Sinks,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rateLimiter = yield* makeRateLimiter(config.sendpulse.rateLimitRps);
      const repo = makeSinksRepo(sql);
      const deps: ConnectorDeps = {
        fetch: (url, init) => globalThis.fetch(url, init),
        rateLimiter,
        apiUrl: config.sendpulse.apiUrl,
      };
      const cache = yield* Ref.make<CacheState | null>(null);

      const rebuild = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const sinks = yield* repo.listWithSecret().pipe(Effect.orDie);
        const connectors = buildConnectors(sinks, deps);
        yield* Ref.set(cache, { builtAt: now, connectors });
        return connectors;
      });

      const all = (): Effect.Effect<readonly SinkConnector[]> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cur = yield* Ref.get(cache);
          if (cur !== null && now - cur.builtAt < config.cacheTtlMillis) {
            return cur.connectors;
          }
          return yield* rebuild;
        });

      return { all };
    }),
  );
