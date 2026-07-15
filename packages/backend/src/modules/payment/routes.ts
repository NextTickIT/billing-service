import { SqlClient } from '@effect/sql';
import {
  Payment,
  PaymentMethod,
  PaymentStatus,
  Role,
} from '@billing-service/shared';
import { Clock, Effect, Option, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { Redacted } from 'effect';

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
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { PAYMENT_CANCEL } from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod, isValidPeriod } from '@/modules/payment/period.js';

const CancelAccepted = Schema.Struct({ status: Schema.Literal('cancelled') });
const CreateAccepted = Schema.Struct({ id: Schema.String });

const CreatePaymentRequest = Schema.Struct({
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: Schema.Int,
  period: Schema.String,
  method: Schema.optional(Schema.Int),
});

const CancelRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

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

const readExternalUser = (request: FastifyRequest): string =>
  (request.query as { readonly externalUserId?: string }).externalUserId ?? '';

const listPayments = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const sql = yield* SqlClient.SqlClient;
    return yield* makePaymentRepo(sql).findByExternalUser(
      readExternalUser(request),
    );
  });

const ChargeFixationSchema = Schema.Struct({
  id: Schema.String,
  incomingEventId: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: Schema.Int,
  source: Schema.String,
  occurredAt: Schema.Date,
});

const PaymentDetail = Schema.Struct({
  ...Payment.fields,
  charges: Schema.Array(ChargeFixationSchema),
});

const getPayment = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const sql = yield* SqlClient.SqlClient;
    const id = readId(request);
    const chargeRepo = makeChargeRepo(sql);
    const paymentRepo = makePaymentRepo(sql);
    const found = yield* paymentRepo.findById(id);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    const charges = yield* chargeRepo.findChargesByPayment(id);
    return { ...found.value, charges };
  });

const createPayment = (
  body: Schema.Schema.Type<typeof CreatePaymentRequest>,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const sql = yield* SqlClient.SqlClient;
    const nowMs = yield* Clock.currentTimeMillis;
    const paidAt = new Date(nowMs);
    if (!isValidPeriod(body.period)) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: `unsupported billing period '${body.period}'`,
        }),
      );
    }
    const currentPeriodEnd = addPeriod(paidAt, body.period);
    const payment = yield* makePaymentRepo(sql).insert({
      externalUserId: body.externalUserId,
      amount: body.amount,
      currency: body.currency,
      method: body.method ?? PaymentMethod.Card,
      period: body.period,
      status: PaymentStatus.Active,
      currentPeriodStart: paidAt,
      currentPeriodEnd,
      nextPaymentDate: currentPeriodEnd,
      recurringTokenRef: null,
      firstFailureAt: null,
      retryAttempt: 0,
    });
    return { id: payment.id };
  });

const cancelPayment = (
  body: Schema.Schema.Type<typeof CancelRequest>,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const actor = yield* operatorActor(request);
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
      action: 'cancel_payment',
      targetType: 'payment',
      targetId: id,
      detail: { reason },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_CANCEL,
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
    path: '/api/payment',
    input: Schema.Unknown,
    output: Schema.Array(Payment),
    handler: listPayments,
  });

  route(fastify, {
    method: 'GET',
    path: '/api/payment/:id',
    input: Schema.Unknown,
    output: PaymentDetail,
    handler: getPayment,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment',
    input: CreatePaymentRequest,
    output: CreateAccepted,
    status: 201,
    handler: createPayment,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/:id/cancel',
    input: CancelRequest,
    output: CancelAccepted,
    status: 202,
    handler: cancelPayment,
  });
}
