import { SqlClient } from '@effect/sql';
import {
  CancelAccepted,
  CancelPaymentRequest,
  CreateAccepted,
  CreatePaymentRequest,
  DeferAccepted,
  DeferPaymentRequest,
  Payment,
  PaymentDetail,
  PaymentMethod,
  PaymentStatus,
  ReactivateAccepted,
  Role,
} from '@billing-service/shared';
import { Clock, Effect, Option, Redacted, Schema } from 'effect';
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
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import {
  PAYMENT_CANCEL,
  PAYMENT_DEFER,
  PAYMENT_REACTIVATE,
} from '@/modules/payment/contracts.js';
import {
  makePaymentRepo,
  type PaymentListFilter,
} from '@/modules/payment/data-access.js';
import { computeDeferral } from '@/modules/payment/domain.js';
import { addPeriod, isValidPeriod } from '@/modules/payment/period.js';

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

interface ListQuery {
  readonly status?: string | readonly string[];
  readonly cancelling?: string;
}

const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.values(
  PaymentStatus,
).filter((v): v is PaymentStatus => typeof v === 'number');

/** Coerce the repeated `status` + `cancelling` query params into a filter. */
const readListFilter = (request: FastifyRequest): PaymentListFilter => {
  const query = request.query as ListQuery;
  const raw = query.status;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const statuses = values
    .map(Number)
    .filter((n): n is PaymentStatus => PAYMENT_STATUSES.includes(n));
  return { statuses, cancelling: query.cancelling === 'true' };
};

const listPayments = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    const sql = yield* SqlClient.SqlClient;
    const externalUserId = readExternalUser(request);
    const repo = makePaymentRepo(sql);
    return externalUserId === ''
      ? yield* repo.listAll(500, readListFilter(request))
      : yield* repo.findByExternalUser(externalUserId);
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
  body: Schema.Schema.Type<typeof CancelPaymentRequest>,
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
    const requested = yield* repo.requestCancel(id);
    if (!requested) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: 'payment is not active (cannot soft-cancel)',
        }),
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

const reactivatePayment = (_input: unknown, request: FastifyRequest) =>
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
    const ok = yield* repo.clearCancelRequest(id);
    if (!ok) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: 'payment is not pending cancellation',
        }),
      );
    }
    const at = yield* Clock.currentTimeMillis;
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'reactivate_payment',
      targetType: 'payment',
      targetId: id,
      detail: {},
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_REACTIVATE,
      idemKey: `reactivate:${id}:${at.toString()}`,
      payload: {
        paymentId: id,
        externalUserId: found.value.externalUserId,
        at,
      },
    });
    return { status: 'active' as const };
  });

/** Deferral preconditions (docs/23): only an active payment, 1..30 days. */
const assertDeferrable = (payment: Payment, days: number) => {
  if (payment.status !== PaymentStatus.Active) {
    return Effect.fail(
      new UnprocessableEntity({
        reason: 'only an active payment can be deferred',
      }),
    );
  }
  if (days < 1 || days > 30) {
    return Effect.fail(
      new UnprocessableEntity({ reason: 'days must be between 1 and 30' }),
    );
  }
  return Effect.void;
};

const deferPayment = (
  body: Schema.Schema.Type<typeof DeferPaymentRequest>,
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
    yield* assertDeferrable(found.value, body.days);
    const { newPeriodEnd, newNextPaymentDate } = computeDeferral(
      found.value,
      body.days,
    );
    yield* repo.defer(id, newPeriodEnd, newNextPaymentDate);
    const at = yield* Clock.currentTimeMillis;
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'defer_payment',
      targetType: 'payment',
      targetId: id,
      detail: { days: body.days },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_DEFER,
      idemKey: `defer:${id}:${at.toString()}`,
      payload: {
        paymentId: id,
        externalUserId: found.value.externalUserId,
        newPeriodEnd: newPeriodEnd.toISOString(),
        days: body.days,
        at,
      },
    });
    return { status: 'deferred' as const, newPeriodEnd };
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
    input: CancelPaymentRequest,
    output: CancelAccepted,
    status: 202,
    handler: cancelPayment,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/:id/reactivate',
    input: Schema.Unknown,
    output: ReactivateAccepted,
    status: 202,
    handler: reactivatePayment,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/:id/defer',
    input: DeferPaymentRequest,
    output: DeferAccepted,
    status: 202,
    handler: deferPayment,
  });
}
