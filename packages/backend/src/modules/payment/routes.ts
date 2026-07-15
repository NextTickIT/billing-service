import { SqlClient } from '@effect/sql';
import { Payment, Role } from '@billing-service/shared';
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
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import {
  CancelRequest,
  SUBSCRIPTION_CANCEL,
} from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

const CancelAccepted = Schema.Struct({ status: Schema.Literal('cancelled') });

const route = makeRoute((app: FastifyInstance) => app.runtime);

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
    const found = yield* makePaymentRepo(sql).findById(readId(request));
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    return found.value;
  });

const listForUser = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* authed(request);
    const sql = yield* SqlClient.SqlClient;
    return yield* makePaymentRepo(sql).findByExternalUser(
      readExternalUser(request),
    );
  });

/** Operator cancel (FR-012): mark cancelled, audit, enqueue the outgoing event. */
const cancel = (body: CancelRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    const actor = yield* authed(request);
    const id = readId(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makePaymentRepo(sql);
    const found = yield* repo.findById(id);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    const cancelled = yield* repo.cancel(id);
    if (!cancelled) {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'payment already cancelled' }),
      );
    }
    const reason = body.reason ?? 'operator';
    yield* makeChargeRepo(sql).insertAudit({
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

export default function payments(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'GET',
    path: '/api/payments/:id',
    input: Schema.Unknown,
    output: Payment,
    handler: getOne,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/payments',
    input: Schema.Unknown,
    output: Schema.Array(Payment),
    handler: listForUser,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/support/payments',
    input: Schema.Unknown,
    output: Schema.Array(Payment),
    handler: listForUser,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/support/payments/:id/cancel',
    input: CancelRequest,
    output: CancelAccepted,
    status: 202,
    handler: cancel,
  });
}
