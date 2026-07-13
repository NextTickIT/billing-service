import fp from 'fastify-plugin';

export default fp(
  (fastify, _opts, done) => {
    // Fastify's built-in pino logger is enabled in app.ts. This plugin is the
    // seam for custom log config / redaction; a no-op in the skeleton.
    fastify.log.debug('logger plugin loaded');
    done();
  },
  { name: 'logger', dependencies: ['config'] },
);
