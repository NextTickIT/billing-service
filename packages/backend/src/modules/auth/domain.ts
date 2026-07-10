import type { Role, Session } from '@billing-service/shared';
import { Clock, Effect, Option, Redacted } from 'effect';

import { Hasher } from '@/infra/hasher.js';
import { AuthConfig } from '@/modules/auth/config.js';
import type {
  CreateAuthTokenBody,
  CreateOperatorBody,
  CreateSessionBody,
} from '@/modules/auth/contracts.js';
import { AuthRepo } from '@/modules/auth/data-access.js';
import { InvalidCredentials, Unauthorized } from '@/modules/auth/errors.js';

/**
 * Auth domain — service functions returning Effects, no classes/methods. Every
 * dependency (persistence, hashing, config, the clock) is pulled from the Effect
 * context, so these functions are pure descriptions that run against either the
 * real `AuthRepoLive`/`HasherLive` or an in-memory test layer. This is the
 * module's reason for existing: the reference for writing domain logic with
 * injected dependencies.
 */

const TOKEN_PREFIX = 'bst_';
const SESSION_TOKEN_PREFIX = 'bss_';

/** Guard: the presented bearer credential must equal the configured admin token
 * (constant-time compare). Fails closed when `ADMIN_TOKEN` is unset. */
export const requireAdmin = (presented: Redacted.Redacted) =>
  Effect.gen(function* () {
    const { adminToken } = yield* AuthConfig;
    const hasher = yield* Hasher;
    const expected = Redacted.value(adminToken);
    if (expected.length === 0) {
      return yield* Effect.fail(
        new Unauthorized({ reason: 'admin token not configured' }),
      );
    }
    const presentedValue = Redacted.value(presented);
    if (!hasher.verifyToken(hasher.hashToken(expected), presentedValue)) {
      return yield* Effect.fail(
        new Unauthorized({ reason: 'invalid admin token' }),
      );
    }
  });

/** Mint an auth token (admin only). Returns the stored token plus the one-time
 * plaintext secret (never persisted in the clear). */
export const createAuthToken = (body: CreateAuthTokenBody) =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const generated = yield* hasher.generateToken(TOKEN_PREFIX);
    const authToken = yield* repo.insertAuthToken({
      alias: body.alias,
      role: body.role,
      // Store only the non-secret scheme marker, never a slice of the secret
      // (that would leak token bytes at rest). A future Bearer-auth module will
      // add a proper public lookup id when it needs to resolve tokens.
      tokenPrefix: TOKEN_PREFIX,
      tokenHash: generated.hash,
    });
    return { authToken, secret: generated.plaintext };
  });

/** Create an operator (admin only). Password is hashed with argon2id. */
export const createOperator = (body: CreateOperatorBody) =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const passwordHash = yield* hasher.hashPassword(body.password);
    return yield* repo.insertOperator({
      login: body.login,
      role: body.role,
      passwordHash,
    });
  });

const issueSession = (operatorId: string, role: Role) =>
  Effect.gen(function* () {
    const repo = yield* AuthRepo;
    const hasher = yield* Hasher;
    const { sessionTtlSeconds } = yield* AuthConfig;
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = new Date(now + sessionTtlSeconds * 1000);
    // Distinct prefix from auth tokens so a future unified Bearer router can
    // route by prefix to the right table (sessions vs auth_tokens).
    const generated = yield* hasher.generateToken(SESSION_TOKEN_PREFIX);
    const session = yield* repo.insertSession({
      operatorId,
      role,
      tokenHash: generated.hash,
      expiresAt,
    });
    return { session, token: generated.plaintext };
  });

/** Sign in with login + password -> a new session (+ one-time token). An unknown
 * login still runs a decoy verify so timing never reveals whether it exists. */
export const signIn = (body: CreateSessionBody) =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const found = yield* repo.findOperatorByLogin(body.login);
    if (Option.isNone(found)) {
      yield* hasher.dummyVerifyPassword(body.password);
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'unknown login' }),
      );
    }
    const operator = found.value;
    const valid = yield* hasher.verifyPassword(
      operator.passwordHash,
      body.password,
    );
    if (!valid) {
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'wrong password' }),
      );
    }
    return yield* issueSession(operator.id, operator.role);
  });

/** Pure expiry check for a session against a wall-clock time (millis). */
export const isExpired = (session: Session, nowMillis: number): boolean =>
  session.expiresAt.getTime() <= nowMillis;

/** Validate a session token (used by a future Bearer-auth caller). Rejects an
 * unknown or expired session as `InvalidCredentials`. */
export const authenticate = (token: string) =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const found = yield* repo.findSessionByTokenHash(hasher.hashToken(token));
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'invalid session' }),
      );
    }
    const now = yield* Clock.currentTimeMillis;
    if (isExpired(found.value, now)) {
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'session expired' }),
      );
    }
    return found.value;
  });
