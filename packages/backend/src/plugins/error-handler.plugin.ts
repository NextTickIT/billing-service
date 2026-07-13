import fp from 'fastify-plugin';

export default fp(
  (fastify, _opts, done) => {
    fastify.setErrorHandler((error, _request, reply) => {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error' });
    });
    done();
  },
  { name: 'error-handler', dependencies: ['config'] },
);
