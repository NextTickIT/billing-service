import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  CardChangeRequest,
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionPublic,
  CheckoutSessionStatus,
  CreateCheckoutSession,
  type NewCheckoutSession,
  ONE_TIME_PERIOD,
  PayInstruction,
  PaymentMethod,
  PaymentStatus,
  SelectMethod,
  SessionCreated,
} from '@billing-service/shared';
import { Clock, Effect, Redacted, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertBffSecret } from '@/infra/http/bff-secret.js';
import { extractBearer } from '@/infra/http/bearer.js';
import {
  CardChangeUnavailable,
  Conflict,
  NotFound,
  Unauthorized,
  UnprocessableEntity,
} from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import {
  type CheckoutRepo,
  makeCheckoutRepo,
} from '@/modules/checkout/data-access.js';
import {
  checkoutPath,
  redirectHostAllowed,
} from '@/modules/checkout/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { isValidPeriod } from '@/modules/payment/period.js';
import {
  ackResponse,
  type CallbackPayload,
  normalizeCallback,
  verifyCallback,
} from '@/modules/wayforpay/callback.js';
import { buildPurchase, buildVerify } from '@/modules/wayforpay/purchase.js';
import {
  normalizeWebhook,
  verifyWebhook,
} from '@/modules/whitepay/callback.js';
import { WhitePay } from '@/modules/whitepay/client.js';
import {
  CryptoPaymentUnavailable,
  type WhitePayError,
} from '@/modules/whitepay/errors.js';

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

/** Refuse a checkout whose post-payment redirect points off the allowed hosts (docs/30). */
const assertRedirectAllowed = (
  allowedHosts: readonly string[],
  url: string | undefined,
): Effect.Effect<void, UnprocessableEntity> =>
  url === undefined || redirectHostAllowed(allowedHosts, url)
    ? Effect.void
    : Effect.fail(
        new UnprocessableEntity({
          reason: `redirect host not allowed: ${url}`,
        }),
      );

/** Both post-payment redirects on a create request must point at an allowed host. */
const assertRedirects = (
  input: CreateCheckoutSession,
  request: FastifyRequest,
): Effect.Effect<void, UnprocessableEntity> =>
  Effect.gen(function* () {
    const hosts = request.server.appConfig.redirectAllowedHosts;
    yield* assertRedirectAllowed(hosts, input.successUrl);
    yield* assertRedirectAllowed(hosts, input.failureUrl);
  });

/** A promo's bonus must be a period in our format (an ISO-8601 duration). Reject a
 * malformed one at creation with a 422 rather than let it throw when the charge applies
 * it in the worker (where it would fail the attempt instead of the caller's request). */
const assertPromo = (input: CreateCheckoutSession) => {
  const promo = input.promo;
  if (promo !== undefined && !isValidPeriod(promo.additionalFreePeriod)) {
    return Effect.fail(
      new UnprocessableEntity({
        reason: `unsupported promo period '${promo.additionalFreePeriod}'`,
      }),
    );
  }
  return Effect.void;
};

/** The optional `Idempotency-Key` header, normalized: a present non-empty value, else null. */
const idempotencyKeyOf = (request: FastifyRequest): string | null => {
  const key = header(request, 'idempotency-key');
  return key !== undefined && key.length > 0 ? key : null;
};

/** An Idempotency-Key, when supplied, must be a sane length — reject an oversized value
 * (a caller bug / abuse) with a 422 rather than persist an unbounded string. */
const assertIdempotencyKey = (request: FastifyRequest) => {
  const key = header(request, 'idempotency-key');
  return key !== undefined && key.length > 200
    ? Effect.fail(
        new UnprocessableEntity({
          reason: 'Idempotency-Key too long (max 200)',
        }),
      )
    : Effect.void;
};

/** The SessionCreated response for a session id + expiry. */
const created = (id: string, expiresAt: Date): SessionCreated => ({
  sessionId: id,
  checkoutUrl: checkoutPath(id),
  expiresAt,
});

/**
 * Insert the session, or replay the existing one when its Idempotency-Key already maps to
 * a session (a retry, or a concurrent create that lost the ON CONFLICT race). The unique
 * index makes this atomic — concurrent creates with one key collapse to a single row and
 * every caller gets the same sessionId/checkoutUrl/expiresAt, so one intent never mints
 * two provider flows. A key-less create (null) always inserts.
 */
const insertOrReplay = (repo: CheckoutRepo, input: NewCheckoutSession) =>
  Effect.gen(function* () {
    const inserted = yield* repo.insert(input);
    const key = input.idempotencyKey;
    if (inserted || key === null) {
      return created(input.id, input.expiresAt);
    }
    const existing = yield* repo.findByIdempotencyKey(key);
    if (existing._tag === 'None') {
      return yield* Effect.fail(new Conflict({ field: 'idempotency key' }));
    }
    return created(existing.value.id, existing.value.expiresAt);
  });

const createSession = (input: CreateCheckoutSession, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    yield* assertRedirects(input, request);
    yield* assertPromo(input);
    yield* assertIdempotencyKey(request);
    const sql = yield* SqlClient.SqlClient;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(
      nowMillis + request.server.appConfig.wayforpay.sessionTtlSeconds * 1000,
    );
    return yield* insertOrReplay(makeCheckoutRepo(sql), {
      id,
      externalUserId: input.externalUserId,
      amount: input.amount,
      currency: input.currency,
      // A recurring checkout always carries its cadence (enforced by the schema); a
      // one-time purchase never renews, so it may omit `period` — store the zero-length
      // sentinel to satisfy the NOT NULL column (it is never read back for a one-time).
      period: input.period ?? ONE_TIME_PERIOD,
      // Default preselected method (Card unless the caller passed one; the schema
      // defaults it to Card). The page can still switch it before Pay.
      method: input.method,
      kind: CheckoutSessionKind.Checkout,
      // Schema-defaulted to true; false opts this checkout into a one-time payment.
      recurring: input.recurring,
      paymentId: null,
      successUrl: input.successUrl ?? null,
      failureUrl: input.failureUrl ?? null,
      // A one-time bonus period applied once, when this session is paid (see CheckoutPromo).
      promo: input.promo ?? null,
      // Opt-in dedup key from the caller's header; null → always a fresh session.
      idempotencyKey: idempotencyKeyOf(request),
      expiresAt,
    });
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
    const {
      amount,
      currency,
      period,
      status,
      kind,
      method,
      successUrl,
      failureUrl,
      expiresAt,
    } = found.value;
    return {
      amount,
      currency,
      period,
      status,
      kind,
      method,
      successUrl,
      failureUrl,
      expiresAt,
    };
  });

/** Card (WayForPay): a 0-amount card change verifies the card (buildVerify) when verify
 * is enabled; otherwise a signed Purchase form the browser POSTs to the provider. */
const payCard = (
  session: CheckoutSession,
  request: FastifyRequest,
): Effect.Effect<PayInstruction> =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    if (
      session.kind === CheckoutSessionKind.CardChange &&
      session.amount === 0 &&
      config.cardVerifyEnabled
    ) {
      return buildVerify(config, session);
    }
    const orderDate = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    return buildPurchase(config, session, orderDate);
  });

/** Crypto (WhitePay): mint a FRESH order on-click and hand back its hosted redirect —
 * minting here (not at session creation) keeps WhitePay's ~2-min rate lock fresh (docs/26).
 * Guarded by `enabled` so a dark deploy refuses crypto (503) instead of calling with an
 * empty slug/token (docs/25). `external_order_id` = the session id, the callback match key. */
const payCrypto = (
  session: CheckoutSession,
  request: FastifyRequest,
): Effect.Effect<
  PayInstruction,
  CryptoPaymentUnavailable | WhitePayError,
  WhitePay
> =>
  Effect.gen(function* () {
    if (!request.server.appConfig.whitepay.enabled) {
      return yield* Effect.fail(
        new CryptoPaymentUnavailable({ reason: 'whitepay disabled' }),
      );
    }
    const client = yield* WhitePay;
    const order = yield* client.createOrder({
      amount: session.amount,
      currency: session.currency,
      externalOrderId: session.id,
    });
    return { kind: 'redirect', url: order.acquiringUrl };
  });

/**
 * Resolve a session and atomically claim it for payment, or fail: 404 when unknown, 409
 * when terminal (completed/expired) or already claimed. The claim IS the idempotency
 * guard — the session id is the key, so a concurrent or repeat /pay (button spam, two
 * tabs, a scripted client) finds the row already pending, loses the created→pending
 * claim, and gets the 409. Exactly one provider order is ever minted per session
 * (docs/26). Returns the now-pending session, ready to hand to a provider.
 */
const claimPayableSession = (repo: CheckoutRepo, id: string, method: number) =>
  Effect.gen(function* () {
    const found = yield* repo.findById(id);
    if (found._tag === 'None') {
      return yield* Effect.fail(new NotFound({ resource: 'checkout session' }));
    }
    const { status } = found.value;
    if (
      status === CheckoutSessionStatus.Completed ||
      status === CheckoutSessionStatus.Expired
    ) {
      return yield* Effect.fail(
        new Conflict({ field: 'checkout session (completed or expired)' }),
      );
    }
    const claimed = yield* repo.claimForPayment(id, method);
    if (!claimed) {
      return yield* Effect.fail(
        new Conflict({
          field: 'checkout session payment (already in progress)',
        }),
      );
    }
    return {
      ...found.value,
      method,
      status: CheckoutSessionStatus.Pending,
    } satisfies CheckoutSession;
  });

const pay = (input: SelectMethod, request: FastifyRequest) =>
  Effect.gen(function* () {
    assertBffSecret(request);
    const sql = yield* SqlClient.SqlClient;
    const repo = makeCheckoutRepo(sql);
    const id = readId(request);
    const session = yield* claimPayableSession(repo, id, input.method);
    // A card handoff is a pure signed form (WayForPay dedups on our orderReference), so it
    // cannot fail. Only crypto calls out to WhitePay: if that mint fails (5xx / disabled),
    // release the claim so the buyer can retry or switch method instead of bricking here.
    if (input.method === PaymentMethod.Crypto) {
      return yield* payCrypto(session, request).pipe(
        Effect.tapError(() => repo.releasePending(id)),
      );
    }
    return yield* payCard(session, request);
  });

const providerOf = (request: FastifyRequest): string =>
  (request.params as { readonly provider: string }).provider;

const header = (request: FastifyRequest, key: string): string | undefined => {
  const value = request.headers[key];
  return typeof value === 'string' ? value : undefined;
};

/** WayForPay serviceUrl callback: 8-field HMAC-MD5, normalize, enqueue, signed accept. */
const wayForPayCallback = (body: unknown, request: FastifyRequest) =>
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

/** WhitePay webhook: HMAC-SHA256 the RAW body against the webhook token (docs/26),
 * normalize into the same pipeline, ack HTTP 200. State is reconciled from the webhook,
 * never the browser redirect. */
const whitePayCallback = (body: unknown, request: FastifyRequest) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.whitepay;
    const verified = verifyWebhook(
      Redacted.value(config.webhookToken),
      request.rawBody ?? '',
      header(request, 'signature'),
    );
    if (!verified) {
      return yield* Effect.fail(new Unauthorized({ reason: 'bad signature' }));
    }
    const event = normalizeWebhook(body);
    const sql = yield* SqlClient.SqlClient;
    yield* enqueue(sql)({
      messageType: PAYMENT_EVENT_RECEIVED,
      idemKey: event.idemKey,
      payload: event,
    });
    return { status: 'accepted' };
  });

/** Provider callbacks share one path (`:provider`); dispatch to the provider's verify +
 * normalize. The two providers ack differently (a signed W4P accept vs a bare 200), so
 * the route output is `Unknown` — an unknown provider is a 404 (AC8: adding one is local). */
const callback = (body: unknown, request: FastifyRequest) => {
  const provider = providerOf(request);
  if (provider === 'whitepay') {
    return whitePayCallback(body, request);
  }
  if (provider === 'wayforpay') {
    return wayForPayCallback(body, request);
  }
  return Effect.fail(new NotFound({ resource: 'provider' }));
};

/**
 * SendPulse-initiated card change (docs/23). Resolve the user's payment: a cancelled
 * one (or none) is refused (409 — start a fresh checkout); a current payment runs a
 * 0-amount Card Verify when enabled, else falls back to a minimal tokenizing Purchase
 * (`cardChangeChargeMinor`); a past_due/renewal_failed payment takes the owed-amount
 * path (a priced Purchase that revives it in place). Either way a `card_change` session
 * is issued and its callback re-tokenizes the SAME payment.
 */
const cardChange = (input: CardChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const found = yield* makePaymentRepo(sql).findByExternalUser(
      input.externalUserId,
    );
    // A card change re-tokenizes the recurring payment; one-time payments (which hold
    // no reusable token) are never its target, so skip past them to the newest recurring.
    const payment = found.find((p) => p.recurring);
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
    // Amount by state: an owed change collects the arrears (revives in place); an
    // active change runs a 0-amount Card Verify when enabled, else falls back to a
    // minimal tokenizing Purchase of `cardChangeChargeMinor` (0 tries free; 1 = 0.01
    // UAH). Either way the callback re-tokenizes the SAME payment.
    const amount = owed
      ? payment.amount
      : config.cardVerifyEnabled
        ? 0
        : config.cardChangeChargeMinor;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(nowMillis + config.sessionTtlSeconds * 1000);
    yield* makeCheckoutRepo(sql).insert({
      id,
      externalUserId: payment.externalUserId,
      amount,
      currency: payment.currency,
      period: payment.period,
      // A card change is always a WayForPay re-tokenization, so it preselects Card.
      method: PaymentMethod.Card,
      kind: CheckoutSessionKind.CardChange,
      // A card change re-tokenizes the recurring payment; never a one-time session.
      recurring: true,
      paymentId: payment.id,
      successUrl: null,
      failureUrl: null,
      // A card change re-tokenizes an existing payment; it grants no bonus period.
      promo: null,
      // Server-initiated (not a caller retry), so it carries no idempotency key.
      idempotencyKey: null,
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
    output: PayInstruction,
    handler: pay,
  });

  route(fastify, {
    method: 'POST',
    path: '/api/providers/:provider/callback',
    input: Schema.Unknown,
    output: Schema.Unknown,
    handler: callback,
  });
}
