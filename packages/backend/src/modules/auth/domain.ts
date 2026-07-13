import { Role } from '@billing-service/shared';
import type {
  CreateAuthToken,
  CreateOperator,
  Session,
} from '@billing-service/shared';
import { Clock, Effect, Option, Redacted } from 'effect';

import { Hasher } from '@/infra/hasher.js';
import {
  Forbidden,
  InvalidCredentials,
  Unauthorized,
} from '@/infra/http/errors.js';
import { AuthConfig } from '@/modules/auth/config.js';
import { AuthRepo } from '@/modules/auth/data-access.js';

const TOKEN_PREFIX = 'bst_';
const SESSION_TOKEN_PREFIX = 'bss_';

/** The authenticated principal a domain operation acts on behalf of. */
export interface Actor {
  readonly role: Role;
}

/** Domain command to create an operator: the public create shape plus the
 * secret password, which never appears in `@billing-service/shared`. */
export type CreateOperatorCommand = CreateOperator & {
  readonly password: Redacted.Redacted;
};

/** Sign-in credentials: an operator's login plus password. */
export type Credentials = Omit<CreateOperatorCommand, 'role'>;

/** Authorization gate: the actor must hold `required`, or the op is Forbidden. */
export const requireRole = (actor: Actor, required: Role) =>
  actor.role === required
    ? Effect.void
    : Effect.fail(
        new Forbidden({ reason: `requires role ${required.toString()}` }),
      );

/** Verify the bootstrap admin credential and yield an admin actor. Fails closed
 * when `ADMIN_TOKEN` is unset, so an empty env can never authenticate. */
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
    if (
      !hasher.verifyToken(hasher.hashToken(expected), Redacted.value(presented))
    ) {
      return yield* Effect.fail(
        new Unauthorized({ reason: 'invalid admin token' }),
      );
    }
    return { role: Role.Admin } satisfies Actor;
  });

export const createAuthToken = (actor: Actor, command: CreateAuthToken) =>
  Effect.gen(function* () {
    yield* requireRole(actor, Role.Admin);
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const generated = yield* hasher.generateToken(TOKEN_PREFIX);
    const authToken = yield* repo.insertAuthToken({
      alias: command.alias,
      role: command.role,
      // Store only the scheme marker, never a slice of the secret — that would
      // leak token bytes at rest.
      tokenPrefix: TOKEN_PREFIX,
      tokenHash: generated.hash,
    });
    return { authToken, secret: generated.plaintext };
  });

export const createOperator = (actor: Actor, command: CreateOperatorCommand) =>
  Effect.gen(function* () {
    yield* requireRole(actor, Role.Admin);
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const passwordHash = yield* hasher.hashPassword(command.password);
    return yield* repo.insertOperator({
      login: command.login,
      role: command.role,
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

export const signIn = (command: Credentials) =>
  Effect.gen(function* () {
    const hasher = yield* Hasher;
    const repo = yield* AuthRepo;
    const found = yield* repo.findOperatorByLogin(command.login);
    if (Option.isNone(found)) {
      // Decoy verify so response timing never reveals whether the login exists.
      yield* hasher.dummyVerifyPassword(command.password);
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'unknown login' }),
      );
    }
    const operator = found.value;
    const valid = yield* hasher.verifyPassword(
      operator.passwordHash,
      command.password,
    );
    if (!valid) {
      return yield* Effect.fail(
        new InvalidCredentials({ reason: 'wrong password' }),
      );
    }
    return yield* issueSession(operator.id, operator.role);
  });

export const isExpired = (session: Session, nowMillis: number): boolean =>
  session.expiresAt.getTime() <= nowMillis;

/** Validate a session token (for a future Bearer-auth caller): an unknown or
 * expired session is rejected as `InvalidCredentials`. */
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
