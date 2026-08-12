import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  CardChangeRequest,
  CheckoutSessionKind,
  CheckoutSessionPublic,
  CheckoutSessionStatus,
  CreateCheckoutSession,
  PaymentStatus,
  PurchaseForm,
  SelectMethod,
  SessionCreated,
} from '@billing-service/shared';
import { Clock, Effect, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  CardChangeUnavailable,
  NotFound,
  Unauthorized,
} from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { checkoutPath } from '@/modules/checkout/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import {
  ackResponse,
  type CallbackPayload,
  normalizeCallback,
  verifyCallback,
} from '@/modules/wayforpay/callback.js';
import { buildPurchase } from '@/modules/wayforpay/purchase.js';

const CallbackAckSchema = Schema.Struct({
  orderReference: Schema.String,
  status: Schema.Literal('accept'),
  time: Schema.Int,
  signature: Schema.String,
});

const route = makeRoute((app: FastifyInstance) => app.runtime);

/** The external system authenticates with a service token to open a session. */
const serviceActor = (request: FastifyRequest) => {
  const presented = extractBearer(request);
  return presented === null
    ? Effect.fail(new Unauthorized({ reason: 'missing bearer token' }))
    : authenticateToken(presented);
};

const readId = (request: FastifyRequest): string =>
  (request.params as { readonly id: string }).id;

const createSession = (input: CreateCheckoutSession, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const sql = yield* SqlClient.SqlClient;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(
      nowMillis + request.server.appConfig.wayforpay.sessionTtlSeconds * 1000,
    );
    yield* makeCheckoutRepo(sql).insert({
      id,
      externalUserId: input.externalUserId,
      amount: input.amount,
      currency: input.currency,
      period: input.period,
      kind: CheckoutSessionKind.Checkout,
      paymentId: null,
      expiresAt,
    });
    return { sessionId: id, checkoutUrl: checkoutPath(id), expiresAt };
  });

const getSession = (_input: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const sql = yield* SqlClient.SqlClient;
    const id = readId(request);
    const found = yield* makeCheckoutRepo(sql).findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    const { amount, currency, period, status, expiresAt } = found.value;
    return { amount, currency, period, status, expiresAt };
  });

const pay = (input: SelectMethod, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makeCheckoutRepo(sql);
    const id = readId(request);
    const found = yield* repo.findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    yield* repo.setPending(id, input.method);
    const orderDate = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return buildPurchase(
      request.server.appConfig.wayforpay,
      {
        ...found.value,
        method: input.method,
        status: CheckoutSessionStatus.Pending,
      },
      orderDate,
    );
  });

const callback = (body: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    const payload = (body ?? {}) as CallbackPayload;
    if (!verifyCallback(config, payload)) {
      return yield* Effect.fail(new Unauthorized({ reason: 'bad signature' }));
    }
    const event = normalizeCallback(payload);
    const sql = yield* SqlClient.SqlClient;
    yield* enqueue(sql)({
      messageType: PAYMENT_EVENT_RECEIVED,
      idemKey: event.idemKey,
      payload: event,
    });
    const time = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return ackResponse(config, event.externalRef, time);
  });

/**
 * SendPulse-initiated card change (docs/23). Resolve the user's payment: a cancelled
 * one (or none) is refused (409 — start a fresh checkout); a current payment needs the
 * standalone Card Verify method enabled (0-amount); a past_due/renewal_failed payment
 * takes the owed-amount path (a priced Purchase that revives it in place). Either way a
 * `card_change` session is issued and its callback re-tokenizes the SAME payment.
 */
const cardChange = (input: CardChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const found = yield* makePaymentRepo(sql).findByExternalUser(
      input.externalUserId,
    );
    const payment = found[0];
    if (payment === undefined || payment.status === PaymentStatus.Cancelled) {
      return yield* Effect.fail(
        new CardChangeUnavailable({
          reason: 'no re-tokenizable payment; start a new checkout',
        }),
      );
    }
    const owed =
      payment.status === PaymentStatus.PastDue ||
      payment.status === PaymentStatus.RenewalFailed;
    if (!owed && !config.cardVerifyEnabled) {
      return yield* Effect.fail(
        new CardChangeUnavailable({ reason: 'card verification is unavailable' }),
      );
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(nowMillis + config.sessionTtlSeconds * 1000);
    yield* makeCheckoutRepo(sql).insert({
      id,
      externalUserId: payment.externalUserId,
      amount: owed ? payment.amount : 0,
      currency: payment.currency,
      period: payment.period,
      kind: CheckoutSessionKind.CardChange,
      paymentId: payment.id,
      expiresAt,
    });
    return { sessionId: id, checkoutUrl: checkoutPath(id), expiresAt };
  });

export default function checkout(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions',
    input: CreateCheckoutSession,
    output: SessionCreated,
    status: 201,
    handler: createSession,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/payment/card-change',
    input: CardChangeRequest,
    output: SessionCreated,
    status: 201,
    handler: cardChange,
  });

  // Public JSON read (AC-9): BFF-proxied; no externalUserId in response.
  route(fastify, {
    method: 'GET',
    path: '/api/checkout-sessions/:id',
    input: Schema.Unknown,
    output: CheckoutSessionPublic,
    handler: getSession,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions/:id/pay',
    input: SelectMethod,
    output: PurchaseForm,
    handler: pay,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/providers/:provider/callback',
    input: Schema.Unknown,
    output: CallbackAckSchema,
    handler: callback,
  });
}
