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

/**
 * Providers post their callbacks with assorted content-types (WayForPay uses
 * form-encoded, not JSON), which Fastify's JSON-only parser rejects with 415. Parse
 * any non-JSON body as a raw string → JSON, falling back to the form-encoded
 * "the whole JSON is the first key" shape WayForPay sends (docs/14).
 */
const parseRawBody = (raw: string): unknown => {
  const tryJson = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryJson(raw);
  if (direct !== undefined) {
    return direct;
  }
  const firstKey = raw.split('&')[0]?.split('=')[0] ?? '';
  return tryJson(decodeURIComponent(firstKey)) ?? {};
};

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
