import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import autoload from '@fastify/autoload';
import Fastify, { type FastifyInstance } from 'fastify';

import '@/types.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

/** Only `*.plugin` files are plugin entrypoints — module part-files
 * (routes/domain/data-access) are imported BY the .plugin, never autoloaded. */
const isPluginFile = (path: string): boolean =>
  path.endsWith('.plugin.js') || path.endsWith('.plugin.ts');

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: true });

  // Pass 1: system plugins — loaded before modules, decorators visible to them.
  await app.register(autoload, {
    dir: join(currentDir, 'plugins'),
    matchFilter: isPluginFile,
  });

  // Pass 2: modules — only each module's *.plugin file is loaded.
  await app.register(autoload, {
    dir: join(currentDir, 'modules'),
    maxDepth: 2,
    dirNameRoutePrefix: false,
    matchFilter: isPluginFile,
  });

  await app.ready();
  return app;
};
