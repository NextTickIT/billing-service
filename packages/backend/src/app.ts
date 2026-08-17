import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import autoload from '@fastify/autoload';
import Fastify, { type FastifyInstance } from 'fastify';

import '@/types.js';
import { parseRawBody } from '@/infra/http/raw-body.js';

const currentDir = fileURLToPath(new URL('.', import.meta.url));

const isPluginFile = (path: string): boolean =>
  path.endsWith('.plugin.js') || path.endsWith('.plugin.ts');

const isRouteFile = (path: string): boolean =>
  path.endsWith('routes.js') || path.endsWith('routes.ts');

export const buildApp = async (): Promise<FastifyInstance> => {
  // Redact the Authorization header from logs (defense in depth; secret fields
  // in request bodies decode straight into `Redacted`).
  const app = Fastify({
    logger: { redact: ['req.headers.authorization'] },
  });

  // application/json keeps Fastify's built-in parser; any other content-type
  // (provider callbacks) is parsed as a raw string into JSON (see parseRawBody).
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
    done(null, parseRawBody(typeof body === 'string' ? body : ''));
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
