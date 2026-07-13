import { SqlClient } from '@effect/sql';
import { Role } from '@billing-service/shared';
import { Effect, Option, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import type { DeliveryStatus } from '@/modules/outbox/contracts.js';
import { makeOutboxRepo } from '@/modules/outbox/data-access.js';
import { PAYMENT_REBIND } from '@/modules/payments/contracts.js';
import { makePaymentsRepo } from '@/modules/payments/data-access.js';
import { authenticateToken } from '@/modules/auth/domain.js';

/**
 * Support / operator surface (docs/06, all audited). The queue of quarantined
 * payments and undelivered events (00 §8.5), and the manual bind that reprocesses
 * an unmatched payment (FR-009). Bind stays thin: it validates + audits + enqueues
 * a `payment_rebind`; the worker records the payment and emits the event.
 */

const BEARER_PREFIX = 'Bearer ';

const extractBearer = (request: FastifyRequest): Redacted.Redacted | null => {
  const header = request.headers.authorization;
  if (header?.startsWith(BEARER_PREFIX) !== true) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : Redacted.make(token);
};

/** Any valid auth-token authorizes the support surface; role boundaries (who may
 * bind) are an open question (00 §11.7) — for now the action is audited. */
const supportActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};

const readId = (request: FastifyRequest): string =>
  (request.params as { readonly id: string }).id;

const readStatus = (request: FastifyRequest): DeliveryStatus => {
  const status = (request.query as { readonly status?: string }).status;
  return status === 'pending' || status === 'delivered' ? status : 'failed';
};

const QuarantineView = Schema.Struct({
  quarantineId: Schema.String,
  incomingEventId: Schema.String,
  source: Schema.String,
  externalRef: Schema.String,
  amount: Schema.Int,
  currency: Schema.Int,
  occurredAt: Schema.Date,
  createdAt: Schema.Date,
});

const DeliveryView = Schema.Struct({
  id: Schema.String,
  eventId: Schema.String,
  sink: Schema.String,
  status: Schema.String,
  attemptCount: Schema.Int,
  deliveredAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
});

const BindRequest = Schema.Struct({
  externalUserId: Schema.String,
  subscriptionId: Schema.optional(Schema.String),
  period: Schema.optional(Schema.String),
  method: Schema.optional(Schema.Int),
});

const BindAccepted = Schema.Struct({ status: Schema.Literal('accepted') });

type BindBody = Schema.Schema.Type<typeof BindRequest>;

const route = makeRoute((app: FastifyInstance) => app.dbRuntime);

/** Validate the quarantine, audit the operator action, enqueue the reprocessing. */
const bind = (request: FastifyRequest, body: BindBody) =>
  Effect.gen(function* () {
    const actor = yield* supportActor(request);
    const quarantineId = readId(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makePaymentsRepo(sql);
    const found = yield* repo.getQuarantine(quarantineId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        new NotFound({ resource: 'quarantine record' }),
      );
    }
    if (found.value.status !== 'open') {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'quarantine already resolved' }),
      );
    }
    yield* repo.insertAudit({
      actor: Role[actor.role],
      action: 'bind_quarantine',
      targetType: 'quarantine',
      targetId: quarantineId,
      detail: { externalUserId: body.externalUserId },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_REBIND,
      idemKey: `rebind:${quarantineId}`,
      payload: {
        incomingEventId: found.value.incomingEventId,
        quarantineId,
        externalUserId: body.externalUserId,
        subscriptionId: body.subscriptionId ?? null,
        period: body.period ?? 'P1M',
        method: body.method ?? 0,
      },
    });
    return { status: 'accepted' as const };
  });

export default function support(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'GET',
    path: '/api/support/quarantine',
    input: Schema.Unknown,
    output: Schema.Array(QuarantineView),
    handler: (_input, request) =>
      Effect.gen(function* () {
        yield* supportActor(request);
        const sql = yield* SqlClient.SqlClient;
        return yield* makePaymentsRepo(sql).listOpenQuarantine();
      }),
  });

  route(fastify, {
    method: 'GET',
    path: '/api/support/deliveries',
    input: Schema.Unknown,
    output: Schema.Array(DeliveryView),
    handler: (_input, request) =>
      Effect.gen(function* () {
        yield* supportActor(request);
        const sql = yield* SqlClient.SqlClient;
        return yield* makeOutboxRepo(sql).listByStatus(readStatus(request));
      }),
  });

  route(fastify, {
    method: 'POST',
    path: '/api/support/quarantine/:id/bind',
    input: BindRequest,
    output: BindAccepted,
    status: 202,
    handler: (body, request) => bind(request, body),
  });
}
