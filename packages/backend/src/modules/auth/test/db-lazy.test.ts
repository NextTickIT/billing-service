import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '@/app.js';

/**
 * The auth module wires a real `SqlLive` into a SEPARATE `dbRuntime`. Because
 * that runtime is lazy, building the app must open NO database connection — only
 * a request that needs the DB (auth, or the `/health` readiness probe) triggers
 * the connect. This test runs with no Postgres available: if `buildApp()` built
 * `SqlLive` eagerly it would hang or fail here.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

test('dbRuntime is decorated but lazy — building the app opens no connection', () => {
  expect(typeof app.dbRuntime.runPromise).toBe('function');
});
