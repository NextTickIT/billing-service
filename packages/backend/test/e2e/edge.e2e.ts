import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  callbackSignatureBase,
  hmacMd5Hex,
} from '@/modules/wayforpay/signature.js';

/**
 * Edge integration test: drives the FULL checkout→operator round-trip THROUGH
 * the Cloudflare Pages BFF handler (`packages/frontend/functions/api/[[path]].ts`)
 * against a REAL, freshly-migrated Postgres.
 *
 * The BFF `onRequest` function is loaded via dynamic import at runtime (the bracket
 * filename and cross-package boundary cannot be resolved by the backend tsconfig).
 * tsx executes it directly, so the real handler code is exercised.
 *
 * Registered as an e2e scenario by the existing `run.ts` harness — same pattern
 * as `routes.e2e.ts`.
 */

interface BffEnv {
  readonly BACKEND_ORIGIN: string;
  readonly BFF_SECRET: string;
}

interface BffEventContext {
  readonly request: Request;
  readonly env: BffEnv;
  readonly params: Record<string, string | string[]>;
  readonly data: Record<string, unknown>;
  readonly next: (input?: Request | string) => Promise<Response>;
}

type BffHandler = (ctx: BffEventContext) => Promise<Response>;

export interface E2eContext {
  readonly baseUrl: string;
  readonly query: (sql: string) => Promise<string>;
}

export interface Scenario {
  readonly name: string;
  readonly run: (ctx: E2eContext) => Promise<void>;
}

const ADMIN_TOKEN = 'e2e-admin-token';
const BFF_SECRET = 'e2e-bff-secret';
// The e2e runner sets a non-empty W4P_SECRET_KEY (run.ts setAppEnv); the hardened
// callback fail-closes on an empty key, so we sign with the same shared secret.
// merchantAccount stays empty on both sides (only the secret gates verification).
const MERCHANT_ACCOUNT = '';
const MERCHANT_SECRET = 'e2e-w4p-secret';

async function loadBffHandler(): Promise<BffHandler> {
  const bffPath = fileURLToPath(
    new URL('../../../frontend/functions/api/[[path]].ts', import.meta.url),
  );
  const mod = (await import(bffPath)) as { onRequest: BffHandler };
  return mod.onRequest;
}

function makeBff(
  handler: BffHandler,
  backendOrigin: string,
): (request: Request) => Promise<Response> {
  return (request: Request) =>
    handler({
      request,
      env: { BACKEND_ORIGIN: backendOrigin, BFF_SECRET },
      params: {},
      data: {},
      next: () => Promise.resolve(new Response(null, { status: 404 })),
    });
}

const postJson = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function signCallback(payload: Record<string, string>): Record<string, string> {
  const signature = hmacMd5Hex(
    callbackSignatureBase({
      merchantAccount: payload['merchantAccount'] ?? '',
      orderReference: payload['orderReference'] ?? '',
      amount: payload['amount'] ?? '',
      currency: payload['currency'] ?? '',
      authCode: payload['authCode'] ?? '',
      cardPan: payload['cardPan'] ?? '',
      transactionStatus: payload['transactionStatus'] ?? '',
      reasonCode: payload['reasonCode'] ?? '',
    }),
    MERCHANT_SECRET,
  );
  return { ...payload, merchantSignature: signature };
}

function extractBssCookie(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = /bss=([^;]+)/.exec(setCookie);
  return match?.[1] ?? null;
}

/** Steps 1–2: seed operator + checkout session; return {sessionId, bffFn}. */
async function seedAndCheckout(baseUrl: string): Promise<{
  sessionId: string;
  bff: (req: Request) => Promise<Response>;
}> {
  const handler = await loadBffHandler();
  const bff = makeBff(handler, baseUrl);

  const opRes = await postJson(
    `${baseUrl}/auth/operators`,
    { login: 'edge-op', password: 'edge-pass', role: 1 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  assert.equal(opRes.status, 201, 'operator created');

  const mintRes = await postJson(
    `${baseUrl}/auth/tokens`,
    { alias: 'edge-svc', role: 2 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  assert.equal(mintRes.status, 201, 'service token minted');
  const { secret: svcSecret } = (await mintRes.json()) as { secret: string };

  const sessionRes = await postJson(
    `${baseUrl}/api/checkout-sessions`,
    { externalUserId: 'edge-user', amount: 30000, currency: 0, period: 'P1M' },
    { authorization: `Bearer ${svcSecret}` },
  );
  assert.equal(sessionRes.status, 201, 'checkout session created');
  const { sessionId } = (await sessionRes.json()) as { sessionId: string };
  return { sessionId, bff };
}

/** Steps 3–5: public checkout read, /pay, and provider callback. */
async function checkoutFlow(
  bff: (req: Request) => Promise<Response>,
  baseUrl: string,
  sessionId: string,
): Promise<void> {
  const getRes = await bff(
    new Request(`${baseUrl}/api/checkout-sessions/${sessionId}`),
  );
  assert.equal(getRes.status, 200, 'GET checkout session via BFF → 200');
  const getBody = (await getRes.json()) as Record<string, unknown>;
  assert.equal(getBody['amount'], 30000, 'correct amount');
  assert.equal(getBody['currency'], 0, 'correct currency');
  assert.equal(getBody['period'], 'P1M', 'correct period');
  assert.equal('externalUserId' in getBody, false, 'no externalUserId (AC9)');

  const payRes = await bff(
    new Request(`${baseUrl}/api/checkout-sessions/${sessionId}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    }),
  );
  assert.equal(payRes.status, 200, 'POST /pay via BFF → 200');
  const payBody = (await payRes.json()) as Record<string, unknown>;
  assert.ok(typeof payBody['action'] === 'string', 'response has action url');
  assert.ok(typeof payBody['fields'] === 'object', 'response has form fields');

  // The session id is the idempotency key: a repeat /pay must not mint a second provider
  // order — the now-pending session loses the created→pending claim and gets a 409.
  assert.equal(
    (
      await bff(
        new Request(`${baseUrl}/api/checkout-sessions/${sessionId}/pay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 0 }),
        }),
      )
    ).status,
    409,
    'repeat POST /pay → 409 (idempotent on session id)',
  );

  const cbRes = await postJson(
    `${baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: sessionId,
      amount: '300',
      currency: 'UAH',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: '',
      recToken: 'tok_edge',
      createdDate: '1700000000',
      transactionType: 'PURCHASE',
    }),
  );
  assert.equal(cbRes.status, 200, 'provider callback accepted');
}

/** Steps 6–9: operator auth gate, login, authenticated access, logout. */
async function operatorFlow(
  bff: (req: Request) => Promise<Response>,
  baseUrl: string,
): Promise<void> {
  const r401 = await bff(
    new Request(`${baseUrl}/api/payment?externalUserId=edge-user`),
  );
  assert.equal(r401.status, 401, 'no bss cookie → 401');

  const loginRes = await bff(
    new Request(`${baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'edge-op', password: 'edge-pass' }),
    }),
  );
  assert.equal(loginRes.status, 200, 'login via BFF → 200');
  const loginBody = (await loginRes.json()) as Record<string, unknown>;
  assert.equal(loginBody['ok'], true, 'login response is {ok:true}');
  assert.equal(
    'token' in loginBody,
    false,
    'session token must not leak in body',
  );
  const bssToken = extractBssCookie(loginRes);
  assert.ok(bssToken !== null && bssToken.length > 0, 'Set-Cookie bss present');

  const r200 = await bff(
    new Request(`${baseUrl}/api/payment?externalUserId=edge-user`, {
      headers: { cookie: `bss=${bssToken}` },
    }),
  );
  assert.equal(r200.status, 200, 'with bss cookie → 200');

  const logoutRes = await bff(
    new Request(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `bss=${bssToken}` },
    }),
  );
  assert.equal(logoutRes.status, 200, 'logout → 200');
  const logoutSetCookie = logoutRes.headers.get('set-cookie') ?? '';
  assert.ok(logoutSetCookie.includes('Max-Age=0'), 'logout clears bss cookie');
}

/**
 * A repeated POST /api/checkout-sessions with the same Idempotency-Key (the CRM's own
 * service-token path, not the BFF) must return the SAME session and create exactly one
 * row — so a retried/parallel create never mints a duplicate WayForPay/WhitePay flow.
 */
async function idempotentCreate(
  baseUrl: string,
  query: (sql: string) => Promise<string>,
): Promise<void> {
  const mintRes = await postJson(
    `${baseUrl}/auth/tokens`,
    { alias: 'idem-svc', role: 2 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  assert.equal(mintRes.status, 201, 'service token minted');
  const { secret } = (await mintRes.json()) as { secret: string };
  const headers = {
    authorization: `Bearer ${secret}`,
    'idempotency-key': 'idem-key-1',
  };
  const body = {
    externalUserId: 'idem-user',
    amount: 30000,
    currency: 0,
    period: 'P1M',
  };

  const first = (await postJson(
    `${baseUrl}/api/checkout-sessions`,
    body,
    headers,
  ).then((r) => r.json())) as { sessionId: string };
  const second = (await postJson(
    `${baseUrl}/api/checkout-sessions`,
    body,
    headers,
  ).then((r) => r.json())) as { sessionId: string };

  assert.equal(
    second.sessionId,
    first.sessionId,
    'same Idempotency-Key → same session',
  );
  const count = (
    await query(
      `SELECT count(*) FROM checkout_sessions WHERE "idempotencyKey" = 'idem-key-1'`,
    )
  ).trim();
  assert.equal(count, '1', 'exactly one session row for the key');
}

interface OpPost {
  readonly path: string;
  readonly cookie: string;
  readonly key: string;
  readonly body: unknown;
}

/** A POST to an operator payment route through the BFF, carrying a bss cookie (auth) and
 * an Idempotency-Key so a re-send dedups. */
function opPost(baseUrl: string, o: OpPost): Request {
  return new Request(`${baseUrl}${o.path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: o.cookie,
      'idempotency-key': o.key,
    },
    body: JSON.stringify(o.body),
  });
}

/** Seed an operator and log in via the BFF, returning its `bss=<token>` cookie. */
async function seedOperatorCookie(
  baseUrl: string,
  bff: (req: Request) => Promise<Response>,
): Promise<string> {
  await postJson(
    `${baseUrl}/auth/operators`,
    { login: 'idem-op', password: 'idem-pass', role: 1 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  const loginRes = await bff(
    new Request(`${baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'idem-op', password: 'idem-pass' }),
    }),
  );
  return `bss=${extractBssCookie(loginRes) ?? ''}`;
}

/**
 * The operator create + defer endpoints are additive (a re-send would book a second
 * payment / grant the free days twice). With an Idempotency-Key both replay: one payment
 * row, and `currentPeriodEnd` advanced exactly once.
 */
async function idempotentPaymentOps(
  baseUrl: string,
  query: (sql: string) => Promise<string>,
): Promise<void> {
  const bff = makeBff(await loadBffHandler(), baseUrl);
  const cookie = await seedOperatorCookie(baseUrl, bff);
  const body = {
    externalUserId: 'idem-pay',
    amount: 30000,
    currency: 0,
    period: 'P1M',
    recurring: false,
  };
  const create = { path: '/api/payment', cookie, key: 'ik-create', body };
  const c1 = (await bff(opPost(baseUrl, create)).then((r) => r.json())) as {
    id: string;
  };
  const c2 = (await bff(opPost(baseUrl, create)).then((r) => r.json())) as {
    id: string;
  };
  assert.equal(
    c2.id,
    c1.id,
    'same key → same payment id (no duplicate create)',
  );
  const rows = (
    await query(
      `SELECT count(*) FROM payments WHERE "externalUserId" = 'idem-pay'`,
    )
  ).trim();
  assert.equal(rows, '1', 'exactly one payment row');
  const defer = {
    path: `/api/payment/${c1.id}/defer`,
    cookie,
    key: 'ik-defer',
    body: { days: 5 },
  };
  const d1 = (await bff(opPost(baseUrl, defer)).then((r) => r.json())) as {
    newPeriodEnd: string;
  };
  const d2 = (await bff(opPost(baseUrl, defer)).then((r) => r.json())) as {
    newPeriodEnd: string;
  };
  assert.equal(
    d2.newPeriodEnd,
    d1.newPeriodEnd,
    'same key → same defer result (applied once)',
  );
  const advancedOnce = (
    await query(
      `SELECT "currentPeriodEnd" = '${d1.newPeriodEnd}'::timestamptz FROM payments WHERE id = '${c1.id}'`,
    )
  ).trim();
  assert.equal(advancedOnce, 't', 'currentPeriodEnd advanced exactly once');
}

export const edgeScenarios: readonly Scenario[] = [
  {
    name: 'BFF edge: full checkout→operator round-trip through the BFF handler',
    run: async ({ baseUrl }) => {
      const { sessionId, bff } = await seedAndCheckout(baseUrl);
      await checkoutFlow(bff, baseUrl, sessionId);
      await operatorFlow(bff, baseUrl);
    },
  },
  {
    name: 'checkout: same Idempotency-Key returns the same session (no duplicate)',
    run: async ({ baseUrl, query }) => {
      await idempotentCreate(baseUrl, query);
    },
  },
  {
    name: 'operator: same Idempotency-Key replays create + defer (no double apply)',
    run: async ({ baseUrl, query }) => {
      await idempotentPaymentOps(baseUrl, query);
    },
  },
];
