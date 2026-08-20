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

  // Every body is read as a raw string first: `parseRawBody` turns it into JSON (or
  // the form-encoded shape WayForPay sends), and the raw bytes are stashed on
  // `request.rawBody` so a webhook that signs the RAW payload (WhitePay HMAC-SHA256)
  // can verify it — re-serializing the parsed JSON would break the signature. Applied
  // to `application/json` too, so provider webhooks posting JSON keep their raw body.
  const parseWithRaw = (
    req: { rawBody?: string },
    body: string | Buffer,
    done: (err: Error | null, value?: unknown) => void,
  ): void => {
    const raw = typeof body === 'string' ? body : '';
    req.rawBody = raw;
    done(null, parseRawBody(raw));
  };
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    parseWithRaw,
  );
  app.addContentTypeParser('*', { parseAs: 'string' }, parseWithRaw);

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
