import type { FastifyInstance } from 'fastify';

import { checkHealth } from '@/modules/health/domain.js';

/**
 * Route-only module: autoloaded directly as the module entrypoint. Health
 * subscribes to no tasks, so it needs no `.plugin`. A module adds a
 * `*.plugin.ts` only when it must register handlers with the TaskRegistry.
 */
export default function health(
  fastify: FastifyInstance,
  _opts: unknown,
  done: () => void,
): void {
  fastify.get('/health', () => fastify.runtime.runSync(checkHealth()));
  done();
}
