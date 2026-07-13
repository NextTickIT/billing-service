import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '@/app.js';

/**
 * Regression guard for the two-runtime split: after the auth module wires a real
 * `SqlLive` into a SEPARATE `dbRuntime`, building the app and hitting `/health`
 * must still touch NO database. These tests run with no Postgres available — if
 * `buildApp()` eagerly built `SqlLive`, they would hang/fail.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

test('GET /health is 200 with no Postgres (auth wiring stays DB-less)', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('dbRuntime is decorated but lazy — building the app opens no connection', () => {
  expect(typeof app.dbRuntime.runPromise).toBe('function');
});
