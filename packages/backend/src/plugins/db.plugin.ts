import fp from 'fastify-plugin';

export default fp(
  (fastify, _opts, done) => {
    // The Database service is provided via the Effect runtime (AppLayer).
    // A real @effect/sql-pg pool attaches here (see infra/db.ts).
    // Skeleton: no connection is opened.
    fastify.log.debug('db plugin loaded (skeleton, no connection)');
    done();
  },
  { name: 'db', dependencies: ['effect'] },
);
