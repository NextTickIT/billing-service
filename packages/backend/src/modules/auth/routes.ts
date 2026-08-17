import {
  AuthToken,
  CreateAuthToken,
  CreateOperator,
  Operator,
  Session,
} from '@billing-service/shared';
import { Effect, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { Unauthorized } from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import {
  authenticateAdminCredential,
  createAuthToken,
  createOperator,
  signIn,
} from '@/modules/auth/domain.js';

/** Backend-only request bodies carry the secret password (never in `shared`);
 * responses hand back the one-time plaintext secret/token exactly once. The
 * request shape is derived from the public create shape plus the secret. */
const CreateOperatorRequest = Schema.extend(
  CreateOperator,
  Schema.Struct({ password: Schema.Redacted(Schema.String) }),
);

const SignInRequest = Schema.Struct({
  login: Schema.String,
  password: Schema.Redacted(Schema.String),
});

const TokenCreated = Schema.Struct({
  authToken: AuthToken,
  secret: Schema.String,
});

const OperatorCreated = Schema.Struct({ operator: Operator });

const SessionCreated = Schema.Struct({
  session: Session,
  token: Schema.String,
});

const BEARER_PREFIX = 'Bearer ';

const extractBearer = (request: FastifyRequest): Redacted.Redacted | null => {
  const header = request.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : Redacted.make(token);
};

/** Transport guard: pull the bearer credential off the request and resolve it to
 * an actor via the domain (the header parsing stays out of the domain). */
const adminActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateAdminCredential(presented);
};

const route = makeRoute((app: FastifyInstance) => app.runtime);

export default function auth(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'POST',
    path: '/auth/tokens',
    input: CreateAuthToken,
    output: TokenCreated,
    status: 201,
    handler: (command, request) =>
      Effect.gen(function* () {
        const actor = yield* adminActor(request);
        return yield* createAuthToken(actor, command);
      }),
  });

  route(fastify, {
    method: 'POST',
    path: '/auth/operators',
    input: CreateOperatorRequest,
    output: OperatorCreated,
    status: 201,
    handler: (command, request) =>
      Effect.gen(function* () {
        const actor = yield* adminActor(request);
        const operator = yield* createOperator(actor, command);
        return { operator };
      }),
  });

  route(fastify, {
    method: 'POST',
    path: '/auth/sessions',
    input: SignInRequest,
    output: SessionCreated,
    status: 201,
    handler: (command) => signIn(command),
  });
}
