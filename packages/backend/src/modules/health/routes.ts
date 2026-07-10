import type { FastifyInstance } from 'fastify';

import { checkHealth } from '@/modules/health/domain.js';

/** Transport layer only: wires the HTTP route to the domain function. */
export const registerHealthRoutes = (fastify: FastifyInstance): void => {
  fastify.get('/health', () => fastify.runtime.runSync(checkHealth()));
};
