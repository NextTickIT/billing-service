import { it } from '@effect/vitest';
import { Role } from '@billing-service/shared';
import { Effect, Layer, Redacted } from 'effect';
import { expect } from 'vitest';

import { Hasher, HasherLive } from '@/infra/hasher.js';
import { makeAuthConfig } from '@/modules/auth/config.js';
import { AuthRepo, makeAuthRepoTest } from '@/modules/auth/data-access.js';
import {
  authenticate,
  createAuthToken,
  createOperator,
  isExpired,
  requireAdmin,
  signIn,
} from '@/modules/auth/domain.js';

const ADMIN = 'admin-secret';

/** A fresh, isolated dependency stack per test: in-memory repo + real Hasher. */
const testLayer = (adminToken = ADMIN) =>
  Layer.mergeAll(
    makeAuthRepoTest(),
    HasherLive,
    makeAuthConfig({
      adminToken: Redacted.make(adminToken),
      sessionTtlSeconds: 3600,
    }),
  );

it.effect('requireAdmin accepts the configured admin token', () =>
  requireAdmin(Redacted.make(ADMIN)).pipe(Effect.provide(testLayer())),
);

it.effect('requireAdmin rejects a wrong token as Unauthorized', () =>
  requireAdmin(Redacted.make('wrong')).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('Unauthorized');
    }),
    Effect.provide(testLayer()),
  ),
);

it.effect('requireAdmin fails closed when ADMIN_TOKEN is empty', () =>
  requireAdmin(Redacted.make('anything')).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('Unauthorized');
    }),
    Effect.provide(testLayer('')),
  ),
);

it.effect('createAuthToken mints a token with a one-time bst_ secret', () =>
  Effect.gen(function* () {
    const { authToken, secret } = yield* createAuthToken({
      alias: 'ci',
      role: Role.Service,
    });
    expect(authToken.alias).toBe('ci');
    expect(authToken.role).toBe(Role.Service);
    expect(secret.startsWith('bst_')).toBe(true);
  }).pipe(Effect.provide(testLayer())),
);

it.effect('createAuthToken rejects a duplicate alias as Conflict', () =>
  Effect.gen(function* () {
    yield* createAuthToken({ alias: 'dup', role: Role.Service });
    const error = yield* createAuthToken({
      alias: 'dup',
      role: Role.Service,
    }).pipe(Effect.flip);
    expect(error._tag).toBe('Conflict');
  }).pipe(Effect.provide(testLayer())),
);

it.effect('an operator can be created and then sign in', () =>
  Effect.gen(function* () {
    const operator = yield* createOperator({
      login: 'alice',
      password: Redacted.make('correct horse battery'),
      role: Role.Operator,
    });
    expect(operator.login).toBe('alice');
    const { session, token } = yield* signIn({
      login: 'alice',
      password: Redacted.make('correct horse battery'),
    });
    expect(session.operatorId).toBe(operator.id);
    expect(session.role).toBe(Role.Operator);
    expect(token.length).toBeGreaterThan(0);
  }).pipe(Effect.provide(testLayer())),
);

it.effect('createOperator rejects a duplicate login as Conflict', () =>
  Effect.gen(function* () {
    yield* createOperator({
      login: 'carol',
      password: Redacted.make('pw-one'),
      role: Role.Operator,
    });
    const error = yield* createOperator({
      login: 'carol',
      password: Redacted.make('pw-two'),
      role: Role.Operator,
    }).pipe(Effect.flip);
    expect(error._tag).toBe('Conflict');
  }).pipe(Effect.provide(testLayer())),
);

it.effect('sign in with a wrong password is InvalidCredentials', () =>
  Effect.gen(function* () {
    yield* createOperator({
      login: 'bob',
      password: Redacted.make('right-pass'),
      role: Role.Operator,
    });
    const error = yield* signIn({
      login: 'bob',
      password: Redacted.make('wrong-pass'),
    }).pipe(Effect.flip);
    expect(error._tag).toBe('InvalidCredentials');
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  'sign in with an unknown login is InvalidCredentials (decoy verify)',
  () =>
    signIn({ login: 'ghost', password: Redacted.make('whatever') }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe('InvalidCredentials');
      }),
      Effect.provide(testLayer()),
    ),
);

it('isExpired compares a session expiry to a wall-clock time', () => {
  const base = {
    id: 's_1',
    operatorId: 'op_1',
    role: Role.Operator,
    createdAt: new Date(0),
  };
  expect(isExpired({ ...base, expiresAt: new Date(10_000) }, 5_000)).toBe(
    false,
  );
  expect(isExpired({ ...base, expiresAt: new Date(5_000) }, 10_000)).toBe(true);
});

it.effect(
  'authenticate returns the session for a valid (unexpired) token',
  () =>
    Effect.gen(function* () {
      const hasher = yield* Hasher;
      const repo = yield* AuthRepo;
      const generated = yield* hasher.generateToken('bss_');
      yield* repo.insertSession({
        operatorId: 'op_1',
        role: Role.Operator,
        tokenHash: generated.hash,
        expiresAt: new Date('2999-01-01T00:00:00.000Z'),
      });
      const session = yield* authenticate(generated.plaintext);
      expect(session.operatorId).toBe('op_1');
      expect(session.role).toBe(Role.Operator);
    }).pipe(Effect.provide(testLayer())),
);

it.effect('authenticate rejects an expired session as InvalidCredentials', () =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const generated = yield* hasher.generateToken('bss_');
    yield* repo.insertSession({
      operatorId: 'op_1',
      role: Role.Operator,
      tokenHash: generated.hash,
      expiresAt: new Date(0), // already in the past
    });
    const error = yield* authenticate(generated.plaintext).pipe(Effect.flip);
    expect(error._tag).toBe('InvalidCredentials');
  }).pipe(Effect.provide(testLayer())),
);

it.effect('authenticate rejects an unknown token as InvalidCredentials', () =>
  authenticate('bss_does-not-exist').pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('InvalidCredentials');
    }),
    Effect.provide(testLayer()),
  ),
);
