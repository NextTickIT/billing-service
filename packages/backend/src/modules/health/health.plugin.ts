import { Effect } from 'effect';
import fp from 'fastify-plugin';

import { registerHealthRoutes } from '@/modules/health/routes.js';

/**
 * The module's registration seam and the ONLY autoloaded file in this folder.
 * It (1) registers the module's HTTP routes and (2) registers the module's
 * message_type handler(s) with the TaskRegistry. Handler is a no-op skeleton.
 */
export default fp(
  (fastify, _opts, done) => {
    registerHealthRoutes(fastify);
    fastify.registerTaskHandler('health.check', () => Effect.void);
    done();
  },
  { name: 'module:health', dependencies: ['task-registry'] },
);
