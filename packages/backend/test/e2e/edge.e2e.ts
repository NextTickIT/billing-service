import assert from 'node:assert/strict';

import {
  ADMIN_TOKEN,
  loadBffHandler,
  makeBff,
  MERCHANT_ACCOUNT,
  postJson,
  signCallback,
} from './http-harness.js';
import { migrationScenarios } from './migration.e2e.js';
import { optionsScenarios } from './options.e2e.js';
import { payNowScenarios } from './pay-now.e2e.js';
import { prolongScenarios } from './prolong.e2e.js';
import { refundBindScenarios } from './refund-bind.e2e.js';
import type { Scenario } from './http-harness.js';

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
 * as `routes.e2e.ts`. The shared HTTP helpers live in `http-harness.ts`; the
 * prolong / method-lock / Q8 scenarios in `prolong.e2e.ts`, the checkout options in
 * `options.e2e.ts`.
 */

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

/** Step 3: the public read the payment page loads — every field it renders, and
 * nothing that would leak the subscriber (AC-9). */
async function assertPublicRead(
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
  // The page discloses subscription vs one-time from this flag, so the public read must
  // carry it — a missing `recurring` would silently render every checkout as one-time.
  assert.equal(getBody['recurring'], true, 'correct recurring flag');
  assert.equal('externalUserId' in getBody, false, 'no externalUserId (AC9)');
}

/** Steps 3–5: public checkout read, /pay, and provider callback. */
async function checkoutFlow(
  bff: (req: Request) => Promise<Response>,
  baseUrl: string,
  sessionId: string,
): Promise<void> {
  await assertPublicRead(bff, baseUrl, sessionId);

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

  // A repeat /pay must not mint a SECOND provider order. It used to be refused outright
  // (409), which also locked out a buyer who simply came back from the provider page
  // without paying — for the whole TTL, a full day. Now the live session is released and
  // the same form re-handed, so the invariant is asserted where it actually lives: the
  // orderReference, which is what WayForPay dedupes on. Same reference ⇒ one order.
  const repeatRes = await bff(
    new Request(`${baseUrl}/api/checkout-sessions/${sessionId}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 0 }),
    }),
  );
  assert.equal(
    repeatRes.status,
    200,
    'repeat POST /pay → 200 (buyer can retry)',
  );
  const repeatBody = (await repeatRes.json()) as {
    fields?: Record<string, unknown>;
  };
  assert.equal(
    repeatBody.fields?.['orderReference'],
    (payBody['fields'] as Record<string, unknown>)['orderReference'],
    'repeat POST /pay re-hands the SAME orderReference — never a second provider order',
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

const putCrmSink = (baseUrl: string, cookie: string, body: unknown): Request =>
  new Request(`${baseUrl}/api/sinks/crm`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

/**
 * The seeded CRM row has no URL and no token. Enabling it as is used to be accepted, and
 * every event was then marked delivered without being sent. The console now answers 422
 * and writes nothing; with both filled the same request enables it.
 */
async function crmSinkEnableGate(
  baseUrl: string,
  query: (sql: string) => Promise<string>,
): Promise<void> {
  const bff = makeBff(await loadBffHandler(), baseUrl);
  const cookie = await seedOperatorCookie(baseUrl, bff);
  const rowSql = `SELECT enabled || '|' || (config->>'url') || '|' || (auth->>'token') FROM sinks WHERE kind = 1`;

  const refused = await bff(putCrmSink(baseUrl, cookie, { enabled: true }));

  assert.equal(refused.status, 422, 'enabling the bare seeded row → 422');
  assert.equal((await query(rowSql)).trim(), 'false||', 'nothing written');

  const accepted = await bff(
    putCrmSink(baseUrl, cookie, {
      enabled: true,
      config: { url: 'https://crm.example/api/public/v1/events' },
      auth: { kind: 0, token: 'crm-token' },
    }),
  );

  assert.equal(accepted.status, 200, 'with a url and a token → 200');
  assert.equal(
    (await query(rowSql)).trim(),
    'true|https://crm.example/api/public/v1/events|crm-token',
    'enabled with both stored',
  );
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
  {
    name: 'operator: the CRM sink cannot be enabled without a URL and a token (422, nothing written)',
    run: async ({ baseUrl, query }) => {
      await crmSinkEnableGate(baseUrl, query);
    },
  },
  ...prolongScenarios,
  ...optionsScenarios,
  ...refundBindScenarios,
  ...migrationScenarios,
  ...payNowScenarios,
];
