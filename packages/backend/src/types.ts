import type { AppConfig } from '@/config.js';
import type { TaskHandler } from '@/infra/task-registry.js';
import type { AppDbRuntime, AppRuntime } from '@/runtime.js';

// Decorators added by system plugins, visible to all modules.
declare module 'fastify' {
  interface FastifyInstance {
    readonly appConfig: AppConfig;
    /** DB-less runtime (health, task registry). */
    readonly runtime: AppRuntime;
    /** DB-backed runtime (auth); lazy — no connection until the first auth run. */
    readonly dbRuntime: AppDbRuntime;
    readonly registerTaskHandler: (
      messageType: string,
      handler: TaskHandler,
    ) => void;
  }
}
