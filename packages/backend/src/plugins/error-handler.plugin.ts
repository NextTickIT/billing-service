import fp from 'fastify-plugin';

/** Fastify hands the handler `unknown`; its framework errors (bad JSON body,
 * schema validation, …) carry a numeric `statusCode`. Read it defensively. */
const statusOf = (error: unknown): number =>
  typeof error === 'object' &&
  error !== null &&
  'statusCode' in error &&
  typeof error.statusCode === 'number'
    ? error.statusCode
    : 500;

export default fp(
  (fastify, _opts, done) => {
    fastify.setErrorHandler((error, _request, reply) => {
      // Honor a framework 4xx `statusCode` so a client mistake reads as 4xx, not
      // a misleading 500. Only genuine server faults (no/5xx code) collapse to a
      // generic 500 (never leak internal error text on those).
      const status = statusOf(error);
      if (status >= 500) {
        fastify.log.error(error);
        return reply.status(status).send({ error: 'Internal Server Error' });
      }
      fastify.log.warn(error);
      const message = error instanceof Error ? error.message : 'Bad Request';
      return reply.status(status).send({ error: message });
    });
    done();
  },
  { name: 'error-handler', dependencies: ['config'] },
);
