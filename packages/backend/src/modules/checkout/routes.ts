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
import { Clock, Effect, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  CardChangeUnavailable,
  NotFound,
  Unauthorized,
} from '@/infra/http/errors.js';
import { toHttp } from '@/infra/http/reply.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { makeRateLimiter } from '@/infra/rate-limiter.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { checkoutPath, verifyCardChange } from '@/modules/checkout/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import {
  ackResponse,
  type CallbackPayload,
  normalizeCallback,
  verifyCallback,
} from '@/modules/wayforpay/callback.js';
import { makeWayForPayClient } from '@/modules/wayforpay/client.js';
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
    const { amount, currency, period, status, kind, expiresAt } = found.value;
    return { amount, currency, period, status, kind, expiresAt };
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
        new CardChangeUnavailable({
          reason: 'card verification is unavailable',
        }),
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

/** Build a WayForPay client bound to app config, with a fresh per-request rate
 * limiter (the app runtime carries no RateLimiterService; a card verify is a single
 * user-driven call, so a short-lived limiter is enough to stay within NFR-03). */
const w4pClientFor = (
  config: FastifyRequest['server']['appConfig']['wayforpay'],
) =>
  Effect.gen(function* () {
    const rateLimiter = yield* makeRateLimiter(config.rateLimitRps);
    return makeWayForPayClient({
      merchantAccount: config.merchantAccount,
      merchantSecretKey: Redacted.value(config.merchantSecretKey),
      merchantPassword: Redacted.value(config.merchantPassword),
      merchantDomainName: config.merchantDomainName,
      apiUrl: config.apiUrl,
      regularApiUrl: config.regularApiUrl,
      verifyUrl: config.verifyUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    });
  });

/** Compose the verify step from request-scoped services (client + repo + config). */
const verifyPage = (request: FastifyRequest) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const client = yield* w4pClientFor(config);
    return yield* verifyCardChange(
      {
        repo: makeCheckoutRepo(sql),
        client,
        cardVerifyEnabled: config.cardVerifyEnabled,
        returnUrl: config.returnUrl,
        serviceUrl: config.serviceUrl,
      },
      readId(request),
    );
  });

/**
 * Serve the verify widget with a RAW reply: the response is text/html, not the JSON
 * that makeRoute's DSL encodes, so this route bypasses it. A typed failure renders
 * through the shared `toHttp` transform (a provider transport error is unmapped → 500,
 * which is acceptable while the live verify call is unconfirmed).
 */
const serveVerify =
  (fastify: FastifyInstance) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      // assertBffSecret throws synchronously (a defect, not a typed failure), so gate
      // here — outside the effect — where the throw maps cleanly to its HTTP reply.
      assertBffSecret(request);
    } catch (error) {
      const http = toHttp(error);
      await reply.status(http.status).send(http.body);
      return;
    }
    const result = await fastify.runtime.runPromise(
      verifyPage(request).pipe(Effect.either),
    );
    if (result._tag === 'Right') {
      await reply.type('text/html; charset=utf-8').send(result.right);
      return;
    }
    const http = toHttp(result.left);
    await reply.status(http.status).send(http.body);
  };

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

  // Card Verify widget — served as raw text/html, so it is registered directly
  // rather than through makeRoute's JSON DSL.
  fastify.route({
    method: 'GET',
    url: '/api/checkout-sessions/:id/verify',
    handler: serveVerify(fastify),
  });

  route(fastify, {
    method: 'POST',
    path: '/api/providers/:provider/callback',
    input: Schema.Unknown,
    output: CallbackAckSchema,
    handler: callback,
  });
}
