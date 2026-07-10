import type { SqlError } from '@effect/sql';
import { Effect, Either, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { HashError } from '@/infra/hasher.js';
import {
  CreateAuthTokenBody,
  CreateOperatorBody,
  CreateSessionBody,
} from '@/modules/auth/contracts.js';
import {
  createAuthToken,
  createOperator,
  requireAdmin,
  signIn,
} from '@/modules/auth/domain.js';
import { Unauthorized, type AuthError } from '@/modules/auth/errors.js';

/**
 * Auth routes — the module's autoloaded entrypoint (transport only). Handlers
 * decode the request, run the domain effect on the DB-backed runtime
 * (`fastify.dbRuntime`, async ⇒ `runPromise`), and map typed `AuthError`s to
 * HTTP status codes. Unmapped failures (SqlError/HashError) propagate and fall
 * through to the generic 500 handler in `error-handler.plugin.ts`.
 */

interface ReplyShape {
  readonly status: number;
  readonly body: unknown;
}

const BAD_REQUEST: ReplyShape = {
  status: 400,
  body: { error: 'Invalid request body' },
};

const BEARER_PREFIX = 'Bearer ';

const send = (reply: FastifyReply, shape: ReplyShape): void => {
  reply.status(shape.status).send(shape.body);
};

const extractBearer = (request: FastifyRequest): Redacted.Redacted | null => {
  const header = request.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : Redacted.make(token);
};

const adminGuard = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : requireAdmin(presented);
};

const authErrorToReply = (error: AuthError): ReplyShape => {
  switch (error._tag) {
    case 'Unauthorized':
      return { status: 401, body: { error: 'Unauthorized' } };
    case 'Forbidden':
      return { status: 403, body: { error: 'Forbidden' } };
    case 'InvalidCredentials':
      return { status: 401, body: { error: 'Invalid credentials' } };
    case 'Conflict':
      return {
        status: 409,
        body: { error: `Conflict: ${error.field} already exists` },
      };
  }
};

/** Convert the domain error channel to a reply, re-raising non-auth failures
 * (SqlError/HashError) so they become a generic 500. */
const handleAuthError = (
  error: AuthError | SqlError.SqlError | HashError,
): Effect.Effect<ReplyShape, SqlError.SqlError | HashError> => {
  switch (error._tag) {
    case 'Unauthorized':
    case 'Forbidden':
    case 'InvalidCredentials':
    case 'Conflict':
      return Effect.succeed(authErrorToReply(error));
    default:
      return Effect.fail(error);
  }
};

const created = (body: unknown): ReplyShape => ({ status: 201, body });

const postTokens = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const parsed = Schema.decodeUnknownEither(CreateAuthTokenBody)(request.body);
  if (Either.isLeft(parsed)) {
    send(reply, BAD_REQUEST);
    return;
  }
  const shape = await request.server.dbRuntime.runPromise(
    adminGuard(request).pipe(
      Effect.andThen(() => createAuthToken(parsed.right)),
      Effect.map(created),
      Effect.catchAll(handleAuthError),
    ),
  );
  send(reply, shape);
};

const postOperators = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const parsed = Schema.decodeUnknownEither(CreateOperatorBody)(request.body);
  if (Either.isLeft(parsed)) {
    send(reply, BAD_REQUEST);
    return;
  }
  const shape = await request.server.dbRuntime.runPromise(
    adminGuard(request).pipe(
      Effect.andThen(() => createOperator(parsed.right)),
      Effect.map((operator) => created({ operator })),
      Effect.catchAll(handleAuthError),
    ),
  );
  send(reply, shape);
};

const postSessions = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const parsed = Schema.decodeUnknownEither(CreateSessionBody)(request.body);
  if (Either.isLeft(parsed)) {
    send(reply, BAD_REQUEST);
    return;
  }
  const shape = await request.server.dbRuntime.runPromise(
    signIn(parsed.right).pipe(
      Effect.map(created),
      Effect.catchAll(handleAuthError),
    ),
  );
  send(reply, shape);
};

export default function auth(
  fastify: FastifyInstance,
  _opts: unknown,
  done: () => void,
): void {
  fastify.post('/auth/tokens', postTokens);
  fastify.post('/auth/operators', postOperators);
  fastify.post('/auth/sessions', postSessions);
  done();
}
