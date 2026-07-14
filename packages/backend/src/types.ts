import type { AppConfig } from '@/config.js';
import type { AppRuntime } from '@/runtime.js';

// Decorators added by system plugins, visible to all modules.
declare module 'fastify' {
  interface FastifyInstance {
    readonly appConfig: AppConfig;
    /** The application Effect runtime (DB-backed; lazy — no connection until the
     * first `run*`). */
    readonly runtime: AppRuntime;
  }
}
