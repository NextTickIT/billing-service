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

import { withIdempotencyKey } from '@/infra/db/idempotency.js';
import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import {
  assertIdempotencyKey,
  idempotencyKeyOf,
} from '@/infra/http/idempotency-key.js';
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

/** Free-text contact search (name/username/email/phone) resolved via the contacts
 * cache — the operator can search the payments table by a person's name. */
const readName = (request: FastifyRequest): string =>
  ((request.query as { readonly name?: string }).name ?? '').trim();

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
    const name = readName(request);
    const repo = makePaymentRepo(sql);
    // An exact contact id wins; else a typed name resolves via the contacts cache;
    // else the default table (status-filtered, 500-row window).
    if (externalUserId !== '') {
      return yield* repo.findByExternalUser(externalUserId);
    }
    if (name !== '') {
      return yield* repo.findByContactName(name);
    }
    return yield* repo.listAll(500, readListFilter(request));
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

/** Insert a fresh operator-created Payment; its terms anchor on now. */
const insertPayment = (
  sql: SqlClient.SqlClient,
  body: Schema.Schema.Type<typeof CreatePaymentRequest>,
) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const paidAt = new Date(nowMs);
    const currentPeriodEnd = addPeriod(paidAt, body.period);
    const payment = yield* makePaymentRepo(sql).insert({
      externalUserId: body.externalUserId,
      amount: body.amount,
      currency: body.currency,
      method: body.method ?? PaymentMethod.Card,
      period: body.period,
      status: PaymentStatus.Active,
      recurring: body.recurring ?? true,
      currentPeriodStart: paidAt,
      currentPeriodEnd,
      nextPaymentDate: currentPeriodEnd,
      recurringTokenRef: null,
      firstFailureAt: null,
      retryAttempt: 0,
    });
    return { id: payment.id };
  });

const createPayment = (
  body: Schema.Schema.Type<typeof CreatePaymentRequest>,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    yield* operatorActor(request);
    yield* assertIdempotencyKey(request);
    if (!isValidPeriod(body.period)) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: `unsupported billing period '${body.period}'`,
        }),
      );
    }
    const sql = yield* SqlClient.SqlClient;
    // Dedup a retried or double-submitted create on the caller's key: one Payment per key
    // (without it, a one-time create would insert a second row — no unique guard applies).
    return yield* withIdempotencyKey(
      'payment.create',
      idempotencyKeyOf(request),
      CreateAccepted,
    )(insertPayment(sql, body));
  });

/** Audit the operator action and enqueue the cancel notify (docs/23). */
const enqueueCancel = (
  sql: SqlClient.SqlClient,
  actor: { readonly role: Role },
  payment: Payment,
  reasonInput?: string,
) =>
  Effect.gen(function* () {
    const reason = reasonInput ?? 'operator';
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'cancel_payment',
      targetType: 'payment',
      targetId: payment.id,
      detail: { reason },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_CANCEL,
      idemKey: `cancel:${payment.id}`,
      payload: {
        subscriptionId: payment.id,
        externalUserId: payment.externalUserId,
        reason,
      },
    });
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
    // Soft-cancel stops a future renewal and lapses at the due date via the scheduler —
    // which only ever processes recurring payments. A one-time payment never renews and
    // is never in `findDue`, so a soft-cancel on it could never lapse (it would hang in
    // "cancelling" forever); refuse it outright.
    if (!found.value.recurring) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: 'only a recurring payment can be cancelled',
        }),
      );
    }
    const requested = yield* repo.requestCancel(id);
    if (!requested) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason:
            'payment cannot be cancelled (already cancelled or cancellation pending)',
        }),
      );
    }
    yield* enqueueCancel(sql, actor, found.value, body.reason);
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

/** Apply a deferral: push the anchor, audit, and enqueue the notify. Wrapped by the
 * idempotency ledger in `deferPayment`, so a re-send neither double-grants the free days
 * nor double-emits `payment_deferred`. */
const applyDefer = (
  sql: SqlClient.SqlClient,
  actor: { readonly role: Role },
  payment: Payment,
  days: number,
) =>
  Effect.gen(function* () {
    const { newPeriodEnd, newNextPaymentDate } = computeDeferral(payment, days);
    yield* makePaymentRepo(sql).defer(
      payment.id,
      newPeriodEnd,
      newNextPaymentDate,
    );
    const at = yield* Clock.currentTimeMillis;
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'defer_payment',
      targetType: 'payment',
      targetId: payment.id,
      detail: { days },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_DEFER,
      idemKey: `defer:${payment.id}:${at.toString()}`,
      payload: {
        paymentId: payment.id,
        externalUserId: payment.externalUserId,
        newPeriodEnd: newPeriodEnd.toISOString(),
        days,
        at,
      },
    });
    return { status: 'deferred' as const, newPeriodEnd };
  });

const deferPayment = (
  body: Schema.Schema.Type<typeof DeferPaymentRequest>,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const actor = yield* operatorActor(request);
    yield* assertIdempotencyKey(request);
    const id = readId(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makePaymentRepo(sql);
    const found = yield* repo.findById(id);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    yield* assertDeferrable(found.value, body.days);
    return yield* withIdempotencyKey(
      'payment.defer',
      idempotencyKeyOf(request),
      DeferAccepted,
    )(applyDefer(sql, actor, found.value, body.days));
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
