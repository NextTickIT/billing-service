import { SqlClient } from '@effect/sql';
import { Role, Subscription } from '@billing-service/shared';
import { Effect, Option, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { extractBearer } from '@/infra/http/bearer.js';
import {
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import { makePaymentsRepo } from '@/modules/payments/data-access.js';
import {
  CancelRequest,
  SUBSCRIPTION_CANCEL,
} from '@/modules/subscription/contracts.js';
import { makeSubscriptionRepo } from '@/modules/subscription/data-access.js';

const CancelAccepted = Schema.Struct({ status: Schema.Literal('cancelled') });

const route = makeRoute((app: FastifyInstance) => app.dbRuntime);

/** Any valid token authorizes these read/support actions (role gating is open). */
const authed = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};

const readId = (request: FastifyRequest): string =>
  (request.params as { readonly id: string }).id;

const readExternalUser = (request: FastifyRequest): string =>
  (request.query as { readonly externalUserId?: string }).externalUserId ?? '';

const getOne = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* authed(request);
    const sql = yield* SqlClient.SqlClient;
    const found = yield* makeSubscriptionRepo(sql).findById(readId(request));
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'subscription' }));
    }
    return found.value;
  });

const listForUser = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* authed(request);
    const sql = yield* SqlClient.SqlClient;
    return yield* makeSubscriptionRepo(sql).findByExternalUser(
      readExternalUser(request),
    );
  });

/** Operator cancel (FR-012): mark cancelled, audit, enqueue the outgoing event. */
const cancel = (body: CancelRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    const actor = yield* authed(request);
    const id = readId(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makeSubscriptionRepo(sql);
    const found = yield* repo.findById(id);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'subscription' }));
    }
    const cancelled = yield* repo.cancel(id);
    if (!cancelled) {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'subscription already cancelled' }),
      );
    }
    const reason = body.reason ?? 'operator';
    yield* makePaymentsRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'cancel_subscription',
      targetType: 'subscription',
      targetId: id,
      detail: { reason },
    });
    yield* enqueue(sql)({
      messageType: SUBSCRIPTION_CANCEL,
      idemKey: `cancel:${id}`,
      payload: {
        subscriptionId: id,
        externalUserId: found.value.externalUserId,
        reason,
      },
    });
    return { status: 'cancelled' as const };
  });

export default function subscriptions(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'GET',
    path: '/api/subscriptions/:id',
    input: Schema.Unknown,
    output: Subscription,
    handler: getOne,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/subscriptions',
    input: Schema.Unknown,
    output: Schema.Array(Subscription),
    handler: listForUser,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/support/subscriptions',
    input: Schema.Unknown,
    output: Schema.Array(Subscription),
    handler: listForUser,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/support/subscriptions/:id/cancel',
    input: CancelRequest,
    output: CancelAccepted,
    status: 202,
    handler: cancel,
  });
}
