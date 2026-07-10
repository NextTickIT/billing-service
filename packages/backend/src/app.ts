import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import autoload from '@fastify/autoload';
import Fastify, { type FastifyInstance } from 'fastify';

import '@/types.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const isPluginFile = (path: string): boolean =>
  path.endsWith('.plugin.js') || path.endsWith('.plugin.ts');

const isRouteFile = (path: string): boolean =>
  path.endsWith('routes.js') || path.endsWith('routes.ts');

export const buildApp = async (): Promise<FastifyInstance> => {
  // Redact the Authorization header from logs (defense in depth; secrets in
  // request bodies are already `Redacted` in `@/modules/auth/contracts`).
  const app = Fastify({
    logger: { redact: ['req.headers.authorization'] },
  });

  // Pass 1: system plugins — loaded before modules, decorators visible to them.
  await app.register(autoload, {
    dir: join(currentDir, 'plugins'),
    matchFilter: isPluginFile,
  });

  // Pass 2: modules — load each module's `routes.ts` entrypoint plus any
  // optional `*.plugin.ts` (task subscription only). `domain`/`data-access`
  // are plain imports and are never autoloaded.
  await app.register(autoload, {
    dir: join(currentDir, 'modules'),
    maxDepth: 2,
    dirNameRoutePrefix: false,
    matchFilter: (path: string) => isRouteFile(path) || isPluginFile(path),
  });

  await app.ready();
  return app;
};
