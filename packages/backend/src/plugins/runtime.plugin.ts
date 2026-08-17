import fp from 'fastify-plugin';

import { makeAppRuntime } from '@/runtime.js';

/**
 * Provides the single application Effect runtime, on which every route runs.
 * `ManagedRuntime.make` is LAZY: decorating opens no Postgres connection —
 * `PgClient` connects on the first `runtime.run*` (an auth route or the `/health`
 * readiness probe). That keeps `buildApp()` and connection-free unit tests hermetic
 * even though `PgClient` connects eagerly once the layer is built.
 */
export default fp(
  (fastify, _opts, done) => {
    const runtime = makeAppRuntime(fastify.appConfig);
    fastify.decorate('runtime', runtime);
    fastify.addHook('onClose', () => runtime.dispose());
    done();
  },
  { name: 'runtime', dependencies: ['config'] },
);
