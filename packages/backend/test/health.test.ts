import { Effect } from 'effect';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { buildApp } from '@/app.js';
import { TaskRegistry } from '@/infra/task-registry.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

test('GET /health returns ok (autoload discovered the module)', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('health module registered exactly one task handler via its .plugin', () => {
  const handlers = app.runtime.runSync(
    Effect.flatMap(TaskRegistry, (registry) => registry.handlers()),
  );
  expect(handlers.has('health.check')).toBe(true);
  expect(handlers.size).toBe(1);
});
