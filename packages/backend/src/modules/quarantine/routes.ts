import { SqlClient } from '@effect/sql';
import {
  BindAccepted,
  QuarantineBindRequest,
  QuarantineView,
  Role,
} from '@billing-service/shared';
import { Effect, Option, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { authenticate, requireRole } from '@/modules/auth/domain.js';
import { PAYMENT_REBIND } from '@/modules/charge/contracts.js';
import {
  type ChargeRepo,
  makeChargeRepo,
} from '@/modules/charge/data-access.js';

type BindBody = Schema.Schema.Type<typeof QuarantineBindRequest>;

const route = makeRoute((app: FastifyInstance) => app.runtime);

const operatorActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  if (presented === null) {
    return Effect.fail(new Unauthorized({ reason: 'missing bearer token' }));
  }
  return authenticate(Redacted.value(presented)).pipe(
    Effect.mapError(() => new Unauthorized({ reason: 'invalid session' })),
    Effect.flatMap((session) =>
      requireRole({ role: session.role }, Role.Operator).pipe(
        Effect.as({ role: session.role }),
      ),
    ),
  );
};

const readId = (request: FastifyRequest): string =>
  (request.params as { readonly id: string }).id;

/**
 * A bind settles a payment, and a refund is money returned: binding one would report it as
 * money received. The worker refuses a bind already queued; this refuses a new one before
 * it is queued, so the operator sees why instead of a 202 that does nothing (docs/34).
 */
const refuseRefund = (repo: ChargeRepo, incomingEventId: string) =>
  repo.getIncomingChargeById(incomingEventId).pipe(
    Effect.flatMap((charge) =>
      Option.isSome(charge) && charge.value.status === 'refunded'
        ? Effect.fail(
            new UnprocessableEntity({
              reason:
                'the charge is a refund and cannot be bound as a payment; once its original payment is settled, run charges:reprocess-refunded (docs/34)',
            }),
          )
        : Effect.void,
    ),
  );

const bind = (body: BindBody, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const actor = yield* operatorActor(request);
    const quarantineId = readId(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makeChargeRepo(sql);
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
    yield* refuseRefund(repo, found.value.incomingEventId);
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

export default function quarantine(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'GET',
    path: '/api/quarantine',
    input: Schema.Unknown,
    output: Schema.Array(QuarantineView),
    handler: (_input, request) =>
      Effect.gen(function* () {
        assertBffSecret(request);
        yield* operatorActor(request);
        const sql = yield* SqlClient.SqlClient;
        return yield* makeChargeRepo(sql).listOpenQuarantine();
      }),
  });

  route(fastify, {
    method: 'POST',
    path: '/api/quarantine/:id/bind',
    input: QuarantineBindRequest,
    output: BindAccepted,
    status: 202,
    handler: bind,
  });
}
