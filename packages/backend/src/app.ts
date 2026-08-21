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
    // Bound the request body well below Fastify's 1 MiB default: every route here is
    // small JSON and the public provider-callback surface is a few KB, so this caps the
    // amplification a raw-string-buffering parser would otherwise expose on an
    // unauthenticated endpoint.
    bodyLimit: 262_144,
  });

  // The raw body is stashed on `request.rawBody` so a webhook that signs the RAW payload
  // (WhitePay HMAC-SHA256) verifies the exact bytes — re-serializing the parsed JSON
  // would break the signature.
  const captureRaw = (
    req: { rawBody?: string },
    body: string | Buffer,
  ): string => {
    const raw = typeof body === 'string' ? body : '';
    req.rawBody = raw;
    return raw;
  };
  // `application/json` keeps STRICT parsing: malformed JSON is a 400, never a silently
  // empty object (which would let a bad body reach a route as `{}`).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = captureRaw(req, body);
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON') as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        done(err);
      }
    },
  );
  // Any other content-type (WayForPay's form-encoded callback) is tolerant: parsed into
  // JSON or the form-encoded shape, falling back to `{}` so it fails validation, not 415.
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    done(null, parseRawBody(captureRaw(req, body)));
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
