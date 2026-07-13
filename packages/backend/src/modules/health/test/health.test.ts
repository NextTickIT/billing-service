import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '@/app.js';
import { TaskRegistry } from '@/infra/task-registry.js';

/**
 * `/health` is a DB-backed readiness probe, so with no reachable database it must
 * report 503 — never a misleading 200. Point the DB at a closed loopback port so
 * the probe's connect fails fast; this stays hermetic (no Postgres required).
 */
let app: FastifyInstance;
const savedEnv = {
  host: process.env['DB_HOST'],
  port: process.env['DB_PORT'],
};

beforeAll(async () => {
  process.env['DB_HOST'] = '127.0.0.1';
  process.env['DB_PORT'] = '1';
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  process.env['DB_HOST'] = savedEnv.host;
  process.env['DB_PORT'] = savedEnv.port;
});

test('GET /health is 503 when the database is unreachable', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
});

test('TaskRegistry is wired but has no handlers (health subscribes to none)', () => {
  const handlers = app.runtime.runSync(
    Effect.flatMap(TaskRegistry, (registry) => registry.handlers()),
  );
  expect(handlers.size).toBe(0);
});
