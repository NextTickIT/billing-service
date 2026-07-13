import fp from 'fastify-plugin';

import { makeRuntime } from '@/runtime.js';

export default fp(
  (fastify, _opts, done) => {
    const runtime = makeRuntime();
    fastify.decorate('runtime', runtime);
    fastify.addHook('onClose', () => runtime.dispose());
    done();
  },
  { name: 'effect', dependencies: ['config'] },
);
