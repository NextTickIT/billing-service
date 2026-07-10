import { Effect } from 'effect';
import fp from 'fastify-plugin';

import { TaskRegistry, type TaskHandler } from '@/infra/task-registry.js';

export default fp(
  (fastify, _opts, done) => {
    // Expose a synchronous helper so a module's .plugin can register its
    // message_type handler(s) with the TaskRegistry living in the runtime.
    const registerTaskHandler = (
      messageType: string,
      handler: TaskHandler,
    ): void => {
      fastify.runtime.runSync(
        Effect.flatMap(TaskRegistry, (registry) =>
          registry.register(messageType, handler),
        ),
      );
    };
    fastify.decorate('registerTaskHandler', registerTaskHandler);
    done();
  },
  { name: 'task-registry', dependencies: ['effect'] },
);
