import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { Role, RoleSchema } from '@/enums/role.js';
import { CreateAuthToken, CreateOperator, Operator } from '@/schemas/auth.js';

const validOperator = {
  id: 'op_1',
  login: 'alice',
  role: Role.Operator,
  createdAt: '2026-07-10T00:00:00.000Z',
};

it.effect(
  'decodes a valid operator (role stays numeric, createdAt is a Date)',
  () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknown(Operator)(validOperator);
      expect(decoded.role).toBe(Role.Operator);
      expect(decoded.createdAt).toBeInstanceOf(Date);
    }),
);

it.effect('rejects an operator missing required fields', () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Schema.decodeUnknown(Operator)({ id: 'op_1' }),
    );
    expect(result._tag).toBe('Failure');
  }),
);

it.effect(
  'CreateOperator omits server-owned id + createdAt (and has no password)',
  () =>
    Effect.gen(function* () {
      const created = yield* Schema.decodeUnknown(CreateOperator)({
        login: 'bob',
        role: Role.Operator,
      });
      expect(created).not.toHaveProperty('id');
      expect(created).not.toHaveProperty('createdAt');
      expect(created).not.toHaveProperty('password');
      // The full Operator still requires id + createdAt.
      const missing = yield* Effect.exit(
        Schema.decodeUnknown(Operator)({ login: 'bob', role: Role.Operator }),
      );
      expect(missing._tag).toBe('Failure');
    }),
);

it.effect('CreateAuthToken keeps only alias + role', () =>
  Effect.gen(function* () {
    const created = yield* Schema.decodeUnknown(CreateAuthToken)({
      alias: 'ci-bot',
      role: Role.Service,
    });
    expect(created.alias).toBe('ci-bot');
    expect(created.role).toBe(Role.Service);
  }),
);

it.effect('RoleSchema accepts a valid role and rejects an unknown one', () =>
  Effect.gen(function* () {
    const ok = yield* Schema.decodeUnknown(RoleSchema)(Role.Admin);
    expect(ok).toBe(Role.Admin);
    const bad = yield* Effect.exit(Schema.decodeUnknown(RoleSchema)(99));
    expect(bad._tag).toBe('Failure');
  }),
);
