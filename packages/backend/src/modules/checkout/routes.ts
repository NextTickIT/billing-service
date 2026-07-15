import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionStatus,
  CreateCheckoutSession,
  SelectMethod,
  SessionCreated,
} from '@billing-service/shared';
import { Clock, Effect, Schema } from 'effect';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { extractBearer } from '@/infra/http/bearer.js';
import { NotFound, Unauthorized } from '@/infra/http/errors.js';
import { makeRoute } from '@/infra/http/route.js';
import { enqueue } from '@/infra/queue/store.js';
import { PAYMENT_EVENT_RECEIVED } from '@/modules/charge/contracts.js';
import { authenticateToken } from '@/modules/auth/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { checkoutPath } from '@/modules/checkout/domain.js';
import {
  ackResponse,
  type CallbackPayload,
  normalizeCallback,
  verifyCallback,
} from '@/modules/wayforpay/callback.js';
import { buildPurchase } from '@/modules/wayforpay/purchase.js';

const PurchaseFormSchema = Schema.Struct({
  action: Schema.String,
  fields: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

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

/**
 * Minimal checkout page (FR-002): method choice + pay, no access data shown.
 * TODO(frontend): a server-rendered stub — the real page belongs in the frontend
 * package; this exists only so the hosted-checkout flow is end-to-end testable.
 */
const pageHtml = (sessionId: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Checkout</title></head>
<body>
  <h1>Complete your payment</h1>
  <button id="card">Pay with card</button>
  <script>
    document.getElementById('card').onclick = async () => {
      const res = await fetch(${JSON.stringify(`/api/checkout-sessions/${sessionId}/pay`)}, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 0 }),
      });
      const { action, fields } = await res.json();
      const form = document.createElement('form');
      form.method = 'POST'; form.action = action;
      for (const [k, v] of Object.entries(fields)) {
        for (const item of Array.isArray(v) ? v : [v]) {
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = k; input.value = String(item);
          form.appendChild(input);
        }
      }
      document.body.appendChild(form); form.submit();
    };
  </script>
</body></html>`;

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
      expiresAt,
    });
    return { sessionId: id, checkoutUrl: checkoutPath(id), expiresAt };
  });

const pay = (input: SelectMethod, request: FastifyRequest) =>
  Effect.gen(function* () {
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

export default function checkout(fastify: FastifyInstance): void {
  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions',
    input: CreateCheckoutSession,
    output: SessionCreated,
    status: 201,
    handler: createSession,
  });

  fastify.get('/checkout/:id', async (request, reply) => {
    const id = (request.params as { readonly id: string }).id;
    const found = await fastify.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        makeCheckoutRepo(sql).findById(id),
      ),
    );
    if (found._tag === 'None') {
      await reply.status(404).type('text/html').send('<h1>Not found</h1>');
      return;
    }
    await reply.type('text/html').send(pageHtml(id));
  });

  route(fastify, {
    method: 'POST',
    path: '/api/checkout-sessions/:id/pay',
    input: SelectMethod,
    output: PurchaseFormSchema,
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
