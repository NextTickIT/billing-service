import type { AppConfig } from '@/config.js';
import type { TaskHandler } from '@/infra/task-registry.js';
import type { AppRuntime } from '@/runtime.js';

// Decorators added by system plugins, visible to all modules.
declare module 'fastify' {
  interface FastifyInstance {
    readonly appConfig: AppConfig;
    readonly runtime: AppRuntime;
    readonly registerTaskHandler: (
      messageType: string,
      handler: TaskHandler,
    ) => void;
  }
}
