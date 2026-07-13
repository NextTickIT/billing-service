import fp from 'fastify-plugin';

import { makeDbRuntime } from '@/runtime.js';

/**
 * Provides the DB-backed Effect runtime used by modules that run queries (auth).
 * `makeDbRuntime` (ManagedRuntime.make) is LAZY: decorating opens no Postgres
 * connection — the pool is built on the first `dbRuntime.run*` from an auth
 * route. That is what keeps `buildApp()` and `GET /health` DB-less even though
 * `SqlLive` connects eagerly once built.
 */
export default fp(
  (fastify, _opts, done) => {
    const dbRuntime = makeDbRuntime(fastify.appConfig);
    fastify.decorate('dbRuntime', dbRuntime);
    fastify.addHook('onClose', () => dbRuntime.dispose());
    done();
  },
  { name: 'db-runtime', dependencies: ['config'] },
);
