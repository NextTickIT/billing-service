import { SqlClient } from '@effect/sql';
import {
  CancelAccepted,
  CancelPaymentRequest,
  CreateAccepted,
  CreatePaymentRequest,
  DeferAccepted,
  DeferRequest,
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
  DeferRefused,
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
import { serviceActor } from '@/modules/auth/service-actor.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import {
  PAYMENT_CANCEL,
  PAYMENT_DEFER,
  PAYMENT_REACTIVATE,
} from '@/modules/payment/contracts.js';
import {
  deferToDate,
  type DeferredTo,
  lockDeferTarget,
  makePaymentRepo,
  type PaymentListFilter,
} from '@/modules/payment/data-access.js';
import {
  handoverDecision,
  operatorDeferBlocked,
  wholeDaysBetween,
} from '@/modules/payment/domain.js';
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

/**
 * Audit the operator action and enqueue the cancel notify (docs/23).
 *
 * `cancelRequestedAt` is the occurrence discriminator, taken from the UPDATE that
 * stamped it rather than a fresh clock read: the queue key and the event key both
 * derive from this one value, so a retried delivery of the SAME cancellation
 * reproduces the same keys, while a genuine cancel → reactivate → cancel produces
 * different ones. It is serialized as ISO-8601 at every layer — a bare `${Date}` in a
 * template literal is a different string from `.toISOString()`, and the two must match.
 */
const enqueueCancel = (
  sql: SqlClient.SqlClient,
  actor: { readonly role: Role },
  payment: Payment,
  {
    reasonInput,
    cancelRequestedAt,
  }: {
    readonly reasonInput: string | undefined;
    readonly cancelRequestedAt: Date;
  },
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
    const occurredAt = cancelRequestedAt.toISOString();
    yield* enqueue(sql)({
      messageType: PAYMENT_CANCEL,
      idemKey: `cancel:${payment.id}:${occurredAt}`,
      payload: {
        subscriptionId: payment.id,
        externalUserId: payment.externalUserId,
        reason,
        cancelRequestedAt: occurredAt,
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
    if (Option.isNone(requested)) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason:
            'payment cannot be cancelled (already cancelled or cancellation pending)',
        }),
      );
    }
    yield* enqueueCancel(sql, actor, found.value, {
      reasonInput: body.reason,
      cancelRequestedAt: requested.value,
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
    const reactivatedAt = yield* repo.clearCancelRequest(id);
    if (Option.isNone(reactivatedAt)) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: 'payment is not pending cancellation',
        }),
      );
    }
    const at = reactivatedAt.value.getTime();
    yield* makeChargeRepo(sql).insertAudit({
      actor: Role[actor.role],
      action: 'reactivate_payment',
      targetType: 'payment',
      targetId: id,
      detail: {},
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_REACTIVATE,
      // The database's own stamp for this reactivation, so a redelivered message dedupes
      // while a genuine cancel → reactivate → cancel → reactivate reports each one.
      idemKey: `reactivate:${id}:${reactivatedAt.value.toISOString()}`,
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

/** Who did a defer, what it was, and what it wrote: the audit row and the notify. */
interface DeferRecord {
  readonly actor: string;
  readonly payment: Payment;
  readonly days: number;
  readonly reason?: 'handover';
  readonly deferred: DeferredTo;
}

/** Audit a defer and enqueue its `payment_deferred` notify, in the caller's transaction. */
const recordDefer = (sql: SqlClient.SqlClient, record: DeferRecord) =>
  Effect.gen(function* () {
    const { payment, days, deferred } = record;
    const reason = record.reason === undefined ? {} : { reason: record.reason };
    const at = yield* Clock.currentTimeMillis;
    yield* makeChargeRepo(sql).insertAudit({
      actor: record.actor,
      action: 'defer_payment',
      targetType: 'payment',
      targetId: payment.id,
      detail: { days, revision: deferred.revision, ...reason },
    });
    yield* enqueue(sql)({
      messageType: PAYMENT_DEFER,
      // Keyed on the anchor this deferral established — deterministic from (payment,
      // days) — rather than on a wall-clock read. The HTTP idempotency ledger already
      // collapses a resent request; this makes the QUEUE message dedupe on its own terms
      // too, so a redelivery cannot grant a second message for one grant.
      idemKey: `defer:${payment.id}:${deferred.newPeriodEnd.toISOString()}`,
      payload: {
        paymentId: payment.id,
        externalUserId: payment.externalUserId,
        newPeriodEnd: deferred.newPeriodEnd.toISOString(),
        days,
        at,
        ...reason,
        revision: deferred.revision,
      },
    });
    return {
      status: 'deferred' as const,
      newPeriodEnd: deferred.newPeriodEnd,
      revision: deferred.revision,
    };
  });

/** Refuse, under the payment's lock, an operator defer of a card-check payment whose
 * first charge is due and untaken (`operatorDeferBlocked`). The lock is held to the end of
 * the ledger's transaction, so the date cannot move between this check and the write. */
const assertNotInFlight = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const target = yield* lockDeferTarget(sql)(id);
    if (
      Option.isSome(target) &&
      operatorDeferBlocked(target.value, yield* Clock.currentTimeMillis)
    ) {
      return yield* Effect.fail(
        new DeferRefused({
          code: 'charge_in_flight',
          reason: 'the first charge is due',
        }),
      );
    }
  });

/**
 * Apply an operator deferral: check, push the anchor, audit, and enqueue the notify. Runs
 * inside the idempotency ledger's fresh execution (`deferPayment`): a re-send replays the
 * saved answer even if the payment changed since, and never double-grants the free days
 * nor double-emits `payment_deferred`.
 */
const applyDefer = (
  sql: SqlClient.SqlClient,
  actor: { readonly role: Role },
  id: string,
  days: number,
) =>
  Effect.gen(function* () {
    const repo = makePaymentRepo(sql);
    const found = yield* repo.findById(id);
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    yield* assertDeferrable(found.value, days);
    yield* assertNotInFlight(sql, id);
    // The end the relative SQL actually wrote: a prolongation may have moved the anchor
    // since `payment` was read, and the response and event must report the real one.
    const deferred = yield* repo.defer(id, days);
    if (Option.isNone(deferred)) {
      return yield* Effect.fail(
        new UnprocessableEntity({
          reason: 'only an active payment can be deferred',
        }),
      );
    }
    return yield* recordDefer(sql, {
      actor: Role[actor.role],
      payment: found.value,
      days,
      deferred: deferred.value,
    });
  });

const operatorDefer = (days: number | undefined, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const actor = yield* operatorActor(request);
    yield* assertIdempotencyKey(request);
    if (days === undefined) {
      return yield* Effect.fail(
        new UnprocessableEntity({ reason: 'days is required' }),
      );
    }
    const sql = yield* SqlClient.SqlClient;
    const id = readId(request);
    if (Option.isNone(yield* makePaymentRepo(sql).findById(id))) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    return yield* withIdempotencyKey(
      'payment.defer',
      idempotencyKeyOf(request),
      DeferAccepted,
    )(applyDefer(sql, actor, id, days));
  });

/**
 * Apply a handover defer under the payment's row lock: the eligibility and bounds checks
 * (`handoverDecision`) and the write see one state. Runs inside the ledger's fresh
 * execution, so a committed request always replays its saved answer.
 */
const applyHandover = (
  sql: SqlClient.SqlClient,
  payment: Payment,
  deferTo: Date,
) =>
  Effect.gen(function* () {
    const target = yield* lockDeferTarget(sql)(payment.id);
    if (Option.isNone(target)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    const decision = handoverDecision(
      target.value,
      deferTo,
      yield* Clock.currentTimeMillis,
    );
    if (decision.kind === 'refuse') {
      return yield* Effect.fail(new DeferRefused(decision));
    }
    if (decision.kind === 'unchanged') {
      return {
        status: 'unchanged' as const,
        newPeriodEnd: target.value.nextPaymentDate,
        revision: target.value.deferRevision,
      };
    }
    const deferred = yield* deferToDate(sql)(payment.id, deferTo);
    if (Option.isNone(deferred)) {
      return yield* Effect.fail(
        new DeferRefused({
          code: 'not_active',
          reason: 'only an active payment can be deferred',
          paymentStatus: target.value.status,
        }),
      );
    }
    return yield* recordDefer(sql, {
      actor: 'service',
      payment,
      days: wholeDaysBetween(target.value.nextPaymentDate, deferTo),
      reason: 'handover',
      deferred: deferred.value,
    });
  });

/**
 * The handover defer: the shared service token, an absolute `deferTo`, and an
 * Idempotency-Key (the caller retries under one key until it gets an answer). Its safety
 * is the request shape (`handoverDecision`), not the credential.
 */
const handoverDefer = (body: DeferRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    yield* assertIdempotencyKey(request);
    const key = idempotencyKeyOf(request);
    if (body.days !== undefined || body.deferTo === undefined || key === null) {
      return yield* Effect.fail(
        new DeferRefused({
          code: 'invalid_request',
          reason:
            'a handover defer takes deferTo (not days) and an Idempotency-Key',
        }),
      );
    }
    const deferTo = body.deferTo;
    const sql = yield* SqlClient.SqlClient;
    const found = yield* makePaymentRepo(sql).findById(readId(request));
    if (Option.isNone(found)) {
      return yield* Effect.fail(new NotFound({ resource: 'payment' }));
    }
    return yield* withIdempotencyKey(
      'payment.defer',
      key,
      DeferAccepted,
    )(applyHandover(sql, found.value, deferTo));
  });

/** Operator defers (`{days}`, BFF secret + operator session) and handover defers
 * (`{reason:'handover', deferTo}`, service token) share the route; the body picks. */
const deferPayment = (body: DeferRequest, request: FastifyRequest) =>
  body.reason === 'handover'
    ? handoverDefer(body, request)
    : operatorDefer(body.days, request);

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
    input: DeferRequest,
    output: DeferAccepted,
    status: 202,
    handler: deferPayment,
  });
}
