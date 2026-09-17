import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  CardChangeRequest,
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionPublic,
  CheckoutSessionStatus,
  CreateCheckoutSession,
  MethodChangeRequest,
  MethodChangeResult,
  type NewCheckoutSession,
  ONE_TIME_PERIOD,
  type Payment,
  PayInstruction,
  PAYMENT_METHOD_CHANGE,
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
  ChangeUnavailable,
  Conflict,
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
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import {
  type CheckoutRepo,
  makeCheckoutRepo,
} from '@/modules/checkout/data-access.js';
import {
  checkoutPath,
  planMethodChange,
  redirectHostAllowed,
} from '@/modules/checkout/domain.js';
import type { MethodChangeNotify } from '@/modules/payment/contracts.js';
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

/** The SessionCreated response for a session id + expiry. */
const created = (
  id: string,
  expiresAt: Date,
  baseUrl: string,
): SessionCreated => ({
  sessionId: id,
  checkoutUrl: checkoutPath(baseUrl, id),
  expiresAt,
});

/**
 * Insert the session, or replay the existing one when its Idempotency-Key already maps to
 * a session (a retry, or a concurrent create that lost the ON CONFLICT race). The unique
 * index makes this atomic — concurrent creates with one key collapse to a single row and
 * every caller gets the same sessionId/checkoutUrl/expiresAt, so one intent never mints
 * two provider flows. A key-less create (null) always inserts.
 */
const insertOrReplay = (
  repo: CheckoutRepo,
  input: NewCheckoutSession,
  baseUrl: string,
) =>
  Effect.gen(function* () {
    const inserted = yield* repo.insert(input);
    const key = input.idempotencyKey;
    if (inserted || key === null) {
      return created(input.id, input.expiresAt, baseUrl);
    }
    const existing = yield* repo.findByIdempotencyKey(key);
    if (existing._tag === 'None') {
      return yield* Effect.fail(new Conflict({ field: 'idempotency key' }));
    }
    return created(existing.value.id, existing.value.expiresAt, baseUrl);
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
    return yield* insertOrReplay(
      makeCheckoutRepo(sql),
      {
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
      },
      request.server.appConfig.checkoutBaseUrl,
    );
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
const claimPayableSession = (
  repo: CheckoutRepo,
  id: string,
  method: number,
  nowMillis: number,
) =>
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
    // Enforce the session TTL at claim time: a link past its `expiresAt` is not payable.
    // Without this the checkout URL (incl. the crypto manual-renewal link with its
    // advertised `windowExpiresAt`) would be a permanent bearer capability. State is still
    // reconciled from the provider webhook, so a payment begun before expiry still settles.
    if (found.value.expiresAt.getTime() <= nowMillis) {
      return yield* Effect.fail(
        new Conflict({ field: 'checkout session (expired)' }),
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
    const nowMillis = yield* Clock.currentTimeMillis;
    const session = yield* claimPayableSession(
      repo,
      id,
      input.method,
      nowMillis,
    );
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

/** A `card_change` session for a method change: it re-tokenizes/switches the SAME recurring
 * payment, preselecting the DESTINATION method. Never one-time, carries no promo/redirects,
 * server-initiated so no idempotency key. */
const changeSession = (
  payment: Payment,
  targetMethod: number,
  amount: number,
  id: string,
  expiresAt: Date,
): NewCheckoutSession => ({
  id,
  externalUserId: payment.externalUserId,
  amount,
  currency: payment.currency,
  period: payment.period,
  method: targetMethod,
  // Reused for ALL method-change sessions (card- and crypto-target): the callback matcher
  // routes on this kind, while the applier keys on the event source, not this label.
  kind: CheckoutSessionKind.CardChange,
  recurring: true,
  paymentId: payment.id,
  successUrl: null,
  failureUrl: null,
  promo: null,
  idempotencyKey: null,
  expiresAt,
});

/** The user's ONE recurring payment a card/method change acts on, or a 409: a cancelled
 * one (or none) is refused — start a fresh checkout. One-time payments hold no reusable
 * token and are never the target, so skip past them to the newest recurring. */
const resolveChangeable = (sql: SqlClient.SqlClient, externalUserId: string) =>
  Effect.gen(function* () {
    const found =
      yield* makePaymentRepo(sql).findByExternalUser(externalUserId);
    // Intentionally accepts a RenewalFailed (owed) recurring payment so a method-change
    // can revive it in place by billing the arrears — a deliberate divergence from
    // `findActiveRecurringByExternalUser`, which treats RenewalFailed as terminal.
    const payment = found.find((p) => p.recurring);
    if (payment === undefined || payment.status === PaymentStatus.Cancelled) {
      return yield* Effect.fail(
        new ChangeUnavailable({
          reason: 'no changeable payment; start a new checkout',
        }),
      );
    }
    return payment;
  });

/** Issue the pay/verify checkout for a method change and return its SessionCreated link. */
const openChangeSession = (
  sql: SqlClient.SqlClient,
  payment: Payment,
  targetMethod: number,
  amount: number,
  request: FastifyRequest,
) =>
  Effect.gen(function* () {
    const config = request.server.appConfig.wayforpay;
    const nowMillis = yield* Clock.currentTimeMillis;
    const id = `chk_${randomUUID()}`;
    const expiresAt = new Date(nowMillis + config.sessionTtlSeconds * 1000);
    yield* makeCheckoutRepo(sql).insert(
      changeSession(payment, targetMethod, amount, id, expiresAt),
    );
    return created(id, expiresAt, request.server.appConfig.checkoutBaseUrl);
  });

/**
 * SendPulse-initiated card change (docs/23): re-tokenize the user's recurring CARD. A
 * cancelled payment (or none) is refused (409 — start a fresh checkout); a current one runs
 * a 0-amount Card Verify when enabled, else a minimal tokenizing Purchase
 * (`cardChangeChargeMinor`); a past_due/renewal_failed one pays the owed amount (revives in
 * place). The card-only special case of `methodChange` below (kept for its callers).
 */
const cardChange = (input: CardChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const payment = yield* resolveChangeable(sql, input.externalUserId);
    const plan = planMethodChange(
      payment,
      PaymentMethod.Card,
      config.cardVerifyEnabled,
      config.cardChangeChargeMinor,
    );
    // A card change is never the no-payment flip (that path is crypto-only), so `plan` is
    // always a checkout; the fallback keeps the type total.
    const amount = plan.action === 'checkout' ? plan.amount : payment.amount;
    return yield* openChangeSession(
      sql,
      payment,
      PaymentMethod.Card,
      amount,
      request,
    );
  });

/**
 * SendPulse-initiated payment-method change (docs/32), previous-method agnostic:
 * switch the user's one recurring payment to `input.method` (0=Card, 1=Crypto). Per
 * `planMethodChange`:
 * - `flip` (an up-to-date subscription → crypto): drop the card token + record crypto with
 *   NO payment — the existing scheduler then prompts a manual crypto renewal next cycle.
 *   Returns `{ kind: 'applied' }`.
 * - `checkout` (→ card always; → crypto while an amount is owed): issue a pay/verify session
 *   in the target method whose callback re-tokenizes/switches the SAME payment. Returns
 *   `{ kind: 'checkout', … }` with the link.
 */
const methodChange = (input: MethodChangeRequest, request: FastifyRequest) =>
  Effect.gen(function* () {
    yield* serviceActor(request);
    const config = request.server.appConfig.wayforpay;
    const sql = yield* SqlClient.SqlClient;
    const payment = yield* resolveChangeable(sql, input.externalUserId);
    const plan = planMethodChange(
      payment,
      input.method,
      config.cardVerifyEnabled,
      config.cardChangeChargeMinor,
    );
    if (plan.action === 'flip') {
      // Already crypto with no stored token → nothing to change; return without mutating
      // or emitting a spurious `method_changed` for a genuine no-op.
      if (
        payment.method === PaymentMethod.Crypto &&
        payment.recurringTokenRef === null
      ) {
        return { kind: 'applied', method: PaymentMethod.Crypto } as const;
      }
      const payments = makePaymentRepo(sql);
      const at = yield* Clock.currentTimeMillis;
      // The no-payment flip mutates the payment but takes no money, so no charge event
      // fires — enqueue `method_changed` so a sink learns the method moved (the paid
      // paths already emit card_change_succeeded / recurring_payment_succeeded). All three
      // writes run in ONE transaction so the request can never leave the sub switched but
      // the notification unsent. The idemKey anchors on the paid-through end (which the flip
      // does not move), so a double-submit / client retry within the period dedupes to ONE
      // notification — wall-clock ms would let each retry re-emit.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* payments.clearToken(payment.id);
          yield* payments.setMethod(payment.id, PaymentMethod.Crypto);
          // Typed so a field rename can't silently drift from what methodChangeNotify
          // decodes in the worker (the queue payload is otherwise `unknown`).
          const payload: MethodChangeNotify = {
            paymentId: payment.id,
            externalUserId: payment.externalUserId,
            method: PaymentMethod.Crypto,
            at,
          };
          yield* enqueue(sql)({
            messageType: PAYMENT_METHOD_CHANGE,
            idemKey: `method-change:${payment.id}:${payment.currentPeriodEnd.toISOString()}`,
            payload,
          });
        }),
      );
      return { kind: 'applied', method: PaymentMethod.Crypto } as const;
    }
    const session = yield* openChangeSession(
      sql,
      payment,
      input.method,
      plan.amount,
      request,
    );
    return { kind: 'checkout', ...session } as const;
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

  route(fastify, {
    method: 'POST',
    path: '/api/payment/method-change',
    input: MethodChangeRequest,
    output: MethodChangeResult,
    handler: methodChange,
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
