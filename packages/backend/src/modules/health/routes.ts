import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';

import { checkHealth } from '@/modules/health/domain.js';

/**
 * `/health` is a readiness probe: 200 only when the database is reachable, else
 * 503. It runs `SELECT 1` on the DB-backed runtime; a failed or timed-out query
 * (no connection) reports unavailable instead of a misleading 200. Use it as a
 * readiness signal — pair with a cheap liveness check if the orchestrator should
 * not restart the process during a transient DB outage.
 */
export default function health(
  fastify: FastifyInstance,
  _opts: unknown,
  done: () => void,
): void {
  fastify.get('/health', async (_request, reply) => {
    const ready = await fastify.runtime
      .runPromise(checkHealth().pipe(Effect.timeout('5 seconds')))
      .then(() => true)
      .catch(() => false);
    reply
      .status(ready ? 200 : 503)
      .send(ready ? { status: 'ok' } : { status: 'unavailable' });
  });
  done();
}
