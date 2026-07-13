import fp from 'fastify-plugin';

import { loadConfig } from '@/config.js';

export default fp(
  (fastify, _opts, done) => {
    fastify.decorate('appConfig', loadConfig());
    done();
  },
  { name: 'config' },
);
