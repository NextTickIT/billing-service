import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import { loadConfig } from '@/config.js';
import {
  registerHandlers,
  runFor,
  seedSub,
  type SubSeed,
  withWorker,
  type WorkerContext,
} from '@/modules/charge/test/e2e-harness.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  manualRenewalSession,
  prolongSession,
} from '@/modules/checkout/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { hmacSha256Hex } from '@/modules/whitepay/callback.js';

import {
  ADMIN_TOKEN,
  loadBffHandler,
  makeBff,
  MERCHANT_ACCOUNT,
  postJson,
  type Scenario,
  signCallback,
} from './http-harness.js';

/**
 * HTTP e2e for `/prolong`, the public session read, the method lock and Q8 (plan §4:
 * T20, T31, T35). The public routes go through the real BFF handler; `/prolong` and
 * session create are called with a service token, as the CRM calls them. Rows the HTTP
 * surface cannot create (a sub in a given state, a lapsed link) are seeded through the
 * production repos on the scenario's database.
 */

export type Json = Record<string, unknown>;

export interface Http {
  readonly baseUrl: string;
  readonly query: (sql: string) => Promise<string>;
  readonly bff: (request: Request) => Promise<Response>;
  /** A service-token bearer secret (the CRM's credential). */
  readonly secret: string;
}

export interface PayResult {
  readonly status: number;
  readonly body: Json;
}

export const FAR = new Date('2030-01-01T00:00:00Z');
export const PAST = new Date('2026-01-01T00:00:00Z');
export const CREATED = String(CheckoutSessionStatus.Created);
export const PENDING = String(CheckoutSessionStatus.Pending);
export const WHITEPAY_PAY_URL = 'https://pay.whitepay.test';
const INTRO = {
  amount: 100,
  currency: 0,
  period: 'P1W',
  renewal: { amount: 30000, period: 'P4W' },
};

/** Run one effect on a worker runtime over this scenario's database. */
export const onDb = async <A, E>(
  effect: Effect.Effect<A, E, WorkerContext>,
): Promise<A> => {
  let out: A | undefined;
  await withWorker(loadConfig(), async (run) => {
    out = await run(effect);
  });
  return out as A;
};

/** Seed recurring subs; resolves to a lookup of the inserted rows by contact. */
export const seedSubs = async (seeds: readonly SubSeed[]) => {
  const rows = await onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.forEach(seeds, (s) => seedSub(makePaymentRepo(sql), s)),
    ),
  );
  return (externalUserId: string): Payment =>
    rows.find((r) => r.externalUserId === externalUserId) ??
    assert.fail(`no seeded sub for ${externalUserId}`);
};

export const insertSessions = (sessions: readonly NewCheckoutSession[]) =>
  onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.forEach(sessions, (s) => makeCheckoutRepo(sql).insert(s)),
    ),
  );

/** A worker pass over the queue (the HTTP app runs no worker in e2e). */
export const drainQueue = () =>
  onDb(
    Effect.gen(function* () {
      yield* registerHandlers;
      yield* runFor(2);
    }),
  );

export const httpContext = async (
  baseUrl: string,
  query: Http['query'],
  alias: string,
): Promise<Http> => {
  const res = await postJson(
    `${baseUrl}/auth/tokens`,
    { alias, role: 2 },
    { authorization: `Bearer ${ADMIN_TOKEN}` },
  );
  assert.equal(res.status, 201, 'service token minted');
  const { secret } = (await res.json()) as { secret: string };
  return {
    baseUrl,
    query,
    bff: makeBff(await loadBffHandler(), baseUrl),
    secret,
  };
};

/** The same credentials against another app instance (same database). */
export const onApp = async (http: Http, baseUrl: string): Promise<Http> => ({
  ...http,
  baseUrl,
  bff: makeBff(await loadBffHandler(), baseUrl),
});

const headers = (http: Http, key?: string): Record<string, string> => ({
  authorization: `Bearer ${http.secret}`,
  ...(key === undefined ? {} : { 'idempotency-key': key }),
});

export const callProlong = (http: Http, externalUserId: string, key?: string) =>
  postJson(
    `${http.baseUrl}/api/payment/prolong`,
    { externalUserId },
    headers(http, key),
  );

export const createSession = (http: Http, body: Json, key?: string) =>
  postJson(`${http.baseUrl}/api/checkout-sessions`, body, headers(http, key));

export const sessionIdOf = async (
  res: Response,
  what: string,
): Promise<string> => {
  assert.equal(res.status, 201, `${what} → 201`);
  return ((await res.json()) as { sessionId: string }).sessionId;
};

const prolongId = async (http: Http, contact: string): Promise<string> =>
  sessionIdOf(await callProlong(http, contact), `prolong ${contact}`);

/** The public read the pay page loads (through the BFF). */
export const publicRead = async (http: Http, id: string): Promise<Json> => {
  const res = await http.bff(
    new Request(`${http.baseUrl}/api/checkout-sessions/${id}`),
  );
  assert.equal(res.status, 200, `GET ${id} → 200`);
  return (await res.json()) as Json;
};

/** `/pay` through the BFF, with an option index when one is picked. */
export const pay = async (
  http: Http,
  id: string,
  method: number,
  option?: number,
): Promise<PayResult> => {
  const res = await http.bff(
    new Request(`${http.baseUrl}/api/checkout-sessions/${id}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        option === undefined ? { method } : { method, option },
      ),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json };
};

/** The session a 200 pay instruction hands to the provider (card form or crypto
 * redirect from the stub, which echoes the session id). */
export const paidSession = (res: PayResult, what: string): string => {
  assert.equal(res.status, 200, `${what} → 200`);
  if (res.body['kind'] === 'form') {
    return String((res.body['fields'] as Json)['orderReference']);
  }
  return String(res.body['url']).replace(`${WHITEPAY_PAY_URL}/`, '');
};

export const scalar = async (http: Http, sql: string): Promise<string> =>
  (await http.query(sql)).trim();

export const statusOf = (http: Http, id: string) =>
  scalar(http, `SELECT status FROM checkout_sessions WHERE id = '${id}'`);

export const sessionsOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT count(*) FROM checkout_sessions WHERE "externalUserId" = '${contact}'`,
  );

/** origin | method | renewalOf | status of a session. */
const lockOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT origin || '|' || method || '|' || "renewalOf" || '|' || status FROM checkout_sessions WHERE id = '${id}'`,
  );

const assertNoInternals = (body: Json, what: string): void => {
  assert.equal('origin' in body, false, `${what}: no origin (X11)`);
  assert.equal('renewalOf' in body, false, `${what}: no renewalOf (X11)`);
  assert.equal('externalUserId' in body, false, `${what}: no externalUserId`);
};

export const assertMethodLocked = (
  res: PayResult,
  method: PaymentMethod,
  what: string,
): void => {
  assert.equal(res.status, 400, `${what} → 400`);
  assert.deepEqual(
    res.body,
    {
      error: 'payment method is fixed for this checkout',
      code: 'method_locked',
      method,
    },
    `${what}: MethodLocked names the method to use`,
  );
};

/** A recurring checkout row as a caller would have created it, for direct seeding. */
export const plainSession = (
  id: string,
  externalUserId: string,
  extra: Partial<NewCheckoutSession> = {},
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: 30000,
  currency: 0,
  period: 'P1M',
  method: PaymentMethod.Card,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: null,
  renewalOf: null,
  options: null,
  idempotencyKey: null,
  email: '',
  expiresAt: FAR,
  ...extra,
});

// ---------------------------------------------------------------------------------
// A stub WhitePay, so crypto `/pay` runs end to end without the network.
// ---------------------------------------------------------------------------------

/** Answers create-order with a hosted URL that echoes the session id. */
const stubWhitePay = (req: IncomingMessage, res: ServerResponse): void => {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    const { external_order_id: orderId } = JSON.parse(raw) as {
      external_order_id: string;
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        order: {
          id: `wp_${orderId}`,
          acquiring_url: `${WHITEPAY_PAY_URL}/${orderId}`,
          status: 'INIT',
        },
      }),
    );
  });
};

/** Set `env` around `body`, restoring every key afterwards. */
export const withEnv = async (
  env: Record<string, string>,
  body: () => Promise<void>,
): Promise<void> => {
  const saved = Object.entries(env).map(([k]) => [k, process.env[k]] as const);
  Object.assign(process.env, env);
  try {
    await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }
  }
};

/** The webhook token the WhitePay app verifies callbacks with (`withWhitePayApp`). */
export const WHITEPAY_WEBHOOK_TOKEN = 'e2e-webhook';

/**
 * Serve a second app over the same database with WhitePay enabled and pointed at the
 * local stub. The config is read when the app is built, so the env is set only around
 * that app's life. `extraEnv` adds scenario-specific knobs for the same app (e.g.
 * `MANUAL_RENEWAL_CYCLE_OPTIONS`).
 */
export const withWhitePayApp = async (
  body: (baseUrl: string) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  const stub = createServer(stubWhitePay);
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address() as AddressInfo;
  const env = {
    WHITEPAY_ENABLED: 'true',
    WHITEPAY_SLUG: 'e2e',
    WHITEPAY_API_TOKEN: 'e2e-token',
    WHITEPAY_WEBHOOK_TOKEN,
    WHITEPAY_API_URL: `http://127.0.0.1:${port.toString()}`,
    ...extraEnv,
  };
  try {
    await withEnv(env, async () => {
      const app = await buildApp();
      try {
        await body(await app.listen({ host: '127.0.0.1', port: 0 }));
      } finally {
        await app.close();
      }
    });
  } finally {
    stub.close();
  }
};

// ---------------------------------------------------------------------------------
// T20 — the /prolong endpoint and the public read.
// ---------------------------------------------------------------------------------

const assertProlongCreated = async (http: Http, contact: string) => {
  const res = await callProlong(http, contact);
  assert.equal(res.status, 201, `${contact} → 201`);
  const body = (await res.json()) as Json;
  assert.deepEqual(Object.keys(body).sort(), [
    'checkoutUrl',
    'expiresAt',
    'sessionId',
  ]);
  const id = String(body['sessionId']);
  const base = loadConfig().checkoutBaseUrl;
  assert.equal(body['checkoutUrl'], `${base}/checkout/${id}`, 'hosted page');
  assert.ok(Date.parse(String(body['expiresAt'])) > Date.now(), 'not expired');
  const read = await publicRead(http, id);
  assert.equal(read['methodLocked'], true, `${contact}: methodLocked`);
  assert.equal(read['prolong'], true, `${contact}: prolong`);
  assert.equal(read['renewal'], null);
  assertNoInternals(read, contact);
};

const t20Statuses = async (http: Http) => {
  const end = new Date('2026-12-01T00:00:00Z');
  await seedSubs([
    { externalUserId: 'sp:t20-active', end },
    { externalUserId: 'sp:t20-pastdue', end, status: PaymentStatus.PastDue },
    { externalUserId: 'sp:t20-rf', end, status: PaymentStatus.RenewalFailed },
    { externalUserId: 'sp:t20-x', end, status: PaymentStatus.Cancelled },
  ]);
  for (const contact of ['sp:t20-active', 'sp:t20-pastdue']) {
    await assertProlongCreated(http, contact);
  }
  for (const contact of ['sp:t20-none', 'sp:t20-rf', 'sp:t20-x']) {
    const res = await callProlong(http, contact);
    assert.equal(res.status, 404, `${contact} → 404`);
    assert.deepEqual(await res.json(), {
      error: 'recurring payment not found',
    });
  }
  const anonymous = await postJson(`${http.baseUrl}/api/payment/prolong`, {
    externalUserId: 'sp:t20-active',
  });
  assert.equal(anonymous.status, 401, 'no bearer → 401');
};

/** A caller-created checkout with renewal terms, a pre-0021 row, bad renewals. */
const t20PublicRead = async (http: Http) => {
  const intro = await sessionIdOf(
    await createSession(http, { externalUserId: 'sp:t20-new', ...INTRO }),
    'create with renewal',
  );
  const read = await publicRead(http, intro);
  assert.deepEqual(read['renewal'], INTRO.renewal);
  assert.equal(read['methodLocked'], false);
  assert.equal(read['prolong'], false);
  assertNoInternals(read, 'create with renewal');
  await http.query(
    `INSERT INTO checkout_sessions (id, "externalUserId", amount, currency, period, method, "expiresAt")
     VALUES ('chk_t20_legacy', 'sp:t20-legacy', 30000, 0, 'P1M', 0, now() + interval '1 day')`,
  );
  const legacy = await publicRead(http, 'chk_t20_legacy');
  assert.equal(legacy['renewal'], null, 'legacy row: renewal null');
  assert.equal(legacy['methodLocked'], false, 'legacy row: not locked');
  assert.equal(legacy['prolong'], false, 'legacy row: not a prolong');
  for (const renewal of [
    { amount: 30000, period: 'P0D' },
    { amount: 0, period: 'P4W' },
    { period: 'P4W' },
  ]) {
    const body = { ...INTRO, externalUserId: 'sp:t20-bad', renewal };
    const res = await createSession(http, body);
    assert.equal(res.status, 400, `renewal ${JSON.stringify(renewal)} → 400`);
  }
};

/** X10: an Idempotency-Key is bound to its contact and its origin. */
const t20KeyReplay = async (http: Http) => {
  const prolong = (contact: string, key: string) =>
    callProlong(http, contact, key);
  const plain = { externalUserId: 'sp:t20-active', amount: 30000, currency: 0 };
  const plainBody = { ...plain, period: 'P4W' };
  const first = await sessionIdOf(
    await prolong('sp:t20-active', 'k-t20'),
    'keyed',
  );
  const again = await sessionIdOf(
    await prolong('sp:t20-active', 'k-t20'),
    'replay',
  );
  assert.equal(again, first, 'same contact + origin → the same session');
  const keyed = `SELECT count(*) FROM checkout_sessions WHERE "idempotencyKey" = 'k-t20'`;
  assert.equal(await scalar(http, keyed), '1', 'one row for the key');
  const other = await prolong('sp:t20-pastdue', 'k-t20');
  assert.equal(other.status, 409, 'another contact → 409');
  const asCreate = await createSession(http, plainBody, 'k-t20');
  assert.equal(asCreate.status, 409, 'a plain create on a /prolong key → 409');
  await sessionIdOf(
    await createSession(http, plainBody, 'k-t20-create'),
    'plain create',
  );
  const asProlong = await prolong('sp:t20-active', 'k-t20-create');
  assert.equal(asProlong.status, 409, 'a /prolong on a plain-create key → 409');
};

const t20ProlongEndpoint: Scenario = {
  name: 'prolong (T20): Active/PastDue → 201, none/RenewalFailed/Cancelled → 404, no bearer → 401; public read; key replay (X10)',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 't20-svc');
    await t20Statuses(http);
    await t20PublicRead(http);
    await t20KeyReplay(http);
  },
};

// ---------------------------------------------------------------------------------
// T31 — the method lock.
// ---------------------------------------------------------------------------------

/** What the pay page learns about a fresh card prolong. */
const assertCardProlongRead = async (http: Http, id: string) => {
  const read = await publicRead(http, id);
  assert.equal(read['methodLocked'], true);
  assert.equal(read['method'], PaymentMethod.Card);
  assert.equal(read['successUrl'], null, 'no redirects on a prolong');
  assert.equal(read['failureUrl'], null);
};

/** A card prolong: locked to Card, Crypto refused without touching the session. */
const t31CardLock = async (http: Http) => {
  const id = await prolongId(http, 'sp:t31-card');
  await assertCardProlongRead(http, id);
  const crypto = await pay(http, id, PaymentMethod.Crypto);
  assertMethodLocked(crypto, PaymentMethod.Card, 'Crypto on a Card prolong');
  assert.equal(await statusOf(http, id), CREATED, 'stays Created');
  const card = await pay(http, id, PaymentMethod.Card);
  assert.equal(paidSession(card, 'Card'), id, 'the form pays this session');
  assert.equal(card.body['kind'], 'form');
  assert.equal(await statusOf(http, id), PENDING);
  const again = await pay(http, id, PaymentMethod.Crypto);
  assertMethodLocked(again, PaymentMethod.Card, 'Crypto on a Pending prolong');
  assert.equal(await statusOf(http, id), PENDING, 'not released (X14)');
};

/** A crypto manual-renewal link is not method-locked: Card is accepted. */
const t31ManualOpen = async (http: Http, sub: Payment) => {
  const key = `manual:${sub.id}:1`;
  await insertSessions([manualRenewalSession(sub, 'chk_t31_manual', FAR, key)]);
  const read = await publicRead(http, 'chk_t31_manual');
  assert.equal(read['methodLocked'], false, 'manual_renewal is not locked');
  assert.equal(read['prolong'], false);
  assert.equal(
    read['method'],
    PaymentMethod.Crypto,
    'preselects the sub method',
  );
  const card = await pay(http, 'chk_t31_manual', PaymentMethod.Card);
  assert.equal(paidSession(card, 'Card on manual'), 'chk_t31_manual');
};

const t31MethodLock: Scenario = {
  name: 'prolong (T31): a card prolong is Card-locked (Crypto → 400, session untouched); a crypto sub with WhitePay off → 503; manual_renewal is open',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 't31-svc');
    const crypto = { method: PaymentMethod.Crypto, token: null } as const;
    const seeded = await seedSubs([
      { externalUserId: 'sp:t31-card', end: FAR },
      { externalUserId: 'sp:t31-crypto', end: FAR, ...crypto },
      {
        externalUserId: 'sp:t31-manual',
        end: PAST,
        status: PaymentStatus.PastDue,
        ...crypto,
      },
    ]);
    await t31CardLock(http);
    const off = await callProlong(http, 'sp:t31-crypto');
    assert.equal(off.status, 503, 'crypto sub with WhitePay disabled → 503');
    await t31ManualOpen(http, seeded('sp:t31-manual'));
  },
};

/** A crypto sub's prolong (WhitePay on) is locked to Crypto. */
const t31CryptoLock = async (http: Http) => {
  const id = await prolongId(http, 'sp:t31w-crypto');
  const read = await publicRead(http, id);
  assert.equal(read['methodLocked'], true);
  assert.equal(read['method'], PaymentMethod.Crypto);
  const card = await pay(http, id, PaymentMethod.Card);
  assertMethodLocked(card, PaymentMethod.Crypto, 'Card on a Crypto prolong');
  assert.equal(await statusOf(http, id), CREATED);
  const crypto = await pay(http, id, PaymentMethod.Crypto);
  assert.deepEqual(crypto, {
    status: 200,
    body: { kind: 'redirect', url: `${WHITEPAY_PAY_URL}/${id}` },
  });
};

/** Two-click flow on a lapsed Card prolong whose sub is now Crypto. */
const t31TwoClick = async (http: Http, sub: Payment) => {
  const click1 = await pay(http, 'chk_t31_e1', PaymentMethod.Card);
  assertMethodLocked(click1, PaymentMethod.Crypto, 'lapsed Card prolong');
  assert.equal(await sessionsOf(http, sub.externalUserId), '1', 'no re-mint');
  assert.equal(await statusOf(http, 'chk_t31_e1'), CREATED, 'nothing claimed');
  const click2 = await pay(http, 'chk_t31_e1', Number(click1.body['method']));
  const replacement = paidSession(click2, 'second click with that method');
  assert.notEqual(replacement, 'chk_t31_e1', 'a fresh order reference');
  assert.equal(
    await lockOf(http, replacement),
    `prolong|${String(PaymentMethod.Crypto)}|${sub.id}|${PENDING}`,
    'a Crypto-locked prolong replacement, claimed',
  );
  const click3 = await pay(http, 'chk_t31_e1', PaymentMethod.Crypto);
  assert.equal(paidSession(click3, 'third click'), replacement, 'reused');
  assert.equal(await sessionsOf(http, sub.externalUserId), '2');
};

/** The mirror: a lapsed Crypto prolong whose sub is now Card. */
const t31Mirror = async (http: Http, sub: Payment) => {
  const crypto = await pay(http, 'chk_t31_e2', PaymentMethod.Crypto);
  assertMethodLocked(crypto, PaymentMethod.Card, 'lapsed Crypto prolong');
  const card = await pay(http, 'chk_t31_e2', PaymentMethod.Card);
  const replacement = paidSession(card, 'Card on the mirror');
  assert.notEqual(replacement, 'chk_t31_e2');
  assert.equal(
    await lockOf(http, replacement),
    `prolong|${String(PaymentMethod.Card)}|${sub.id}|${PENDING}`,
    'a Card-locked prolong replacement, claimed',
  );
};

/** A live replacement locked to the OLD method is not handed out for the new one. */
const t31ReuseSameMethodOnly = async (http: Http, sub: Payment) => {
  const crypto = await pay(http, 'chk_t31_e3', PaymentMethod.Crypto);
  const replacement = paidSession(crypto, 'Crypto beside a Card replacement');
  assert.notEqual(replacement, 'chk_t31_live_card', 'not the Card one');
  assert.equal(
    await lockOf(http, replacement),
    `prolong|${String(PaymentMethod.Crypto)}|${sub.id}|${PENDING}`,
  );
  assert.equal(
    await lockOf(http, 'chk_t31_live_card'),
    `prolong|${String(PaymentMethod.Card)}|${sub.id}|${CREATED}`,
    'the old replacement is untouched',
  );
};

/** Links minted before the method changed: Card→Crypto, Crypto→Card, and (reuse) a
 * stale Card link beside a live Card replacement from an earlier click. */
const seedStaleProlongs = async () => {
  const crypto = { method: PaymentMethod.Crypto, token: null } as const;
  const seeded = await seedSubs([
    { externalUserId: 'sp:t31w-crypto', end: FAR, ...crypto },
    { externalUserId: 'sp:t31w-switch', end: FAR, ...crypto },
    { externalUserId: 'sp:t31w-mirror', end: FAR },
    { externalUserId: 'sp:t31w-reuse', end: FAR, ...crypto },
  ]);
  const subs = {
    switched: seeded('sp:t31w-switch'),
    mirrored: seeded('sp:t31w-mirror'),
    reused: seeded('sp:t31w-reuse'),
  };
  const asCard = { method: PaymentMethod.Card };
  const asCrypto = { method: PaymentMethod.Crypto };
  await insertSessions([
    prolongSession({ ...subs.switched, ...asCard }, 'chk_t31_e1', PAST, null),
    prolongSession({ ...subs.mirrored, ...asCrypto }, 'chk_t31_e2', PAST, null),
    prolongSession({ ...subs.reused, ...asCard }, 'chk_t31_e3', PAST, null),
    prolongSession(
      { ...subs.reused, ...asCard },
      'chk_t31_live_card',
      FAR,
      null,
    ),
  ]);
  return subs;
};

const t31CryptoAndRemint: Scenario = {
  name: 'prolong (T31): crypto prolong is Crypto-locked; a lapsed prolong re-mints at the sub CURRENT method (two-click flow, both directions, replacement reuse)',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 't31w-svc');
    const subs = await seedStaleProlongs();
    await withWhitePayApp(async (wpUrl) => {
      const wp = await onApp(http, wpUrl);
      await t31CryptoLock(wp);
      await t31TwoClick(wp, subs.switched);
      await t31Mirror(wp, subs.mirrored);
      await t31ReuseSameMethodOnly(wp, subs.reused);
    });
  },
};

// ---------------------------------------------------------------------------------
// T35 — Q8: an intro price is for new customers only.
// ---------------------------------------------------------------------------------

const t35IntroRefused = async (http: Http, contact: string) => {
  const id = await sessionIdOf(
    await createSession(http, { externalUserId: contact, ...INTRO }),
    `intro for ${contact}`,
  );
  const res = await pay(http, id, PaymentMethod.Card);
  assert.equal(res.status, 409, `${contact}: intro on a live sub → 409`);
  assert.deepEqual(res.body, {
    error: 'already subscribed',
    code: 'already_subscribed',
  });
  assert.equal(await statusOf(http, id), CREATED, 'session unchanged');
};

/** The signed WayForPay success callback for `orderReference`. */
const cardPaid = (http: Http, orderReference: string, recToken: string) =>
  postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference,
      amount: '300',
      currency: 'UAH',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: '',
      recToken,
      createdDate: '1700000000',
      transactionType: 'PURCHASE',
    }),
  );

/** Non-intro links on a live sub are payable and stack (AC 12). */
const t35NonIntroStacks = async (http: Http, sub: Payment) => {
  const terms = {
    externalUserId: sub.externalUserId,
    amount: 30000,
    currency: 0,
    period: 'P1M',
  };
  const sameRenewal = { ...terms, renewal: { amount: 30000, period: 'P1M' } };
  const same = await sessionIdOf(
    await createSession(http, sameRenewal),
    'same',
  );
  const none = await sessionIdOf(await createSession(http, terms), 'none');
  paidSession(await pay(http, none, PaymentMethod.Card), 'no renewal');
  paidSession(await pay(http, same, PaymentMethod.Card), 'renewal = first');
  const cb = await cardPaid(http, same, 'tok_after');
  assert.equal(cb.status, 200, 'callback accepted');
  await drainQueue();
  assert.equal(
    await scalar(
      http,
      `SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '|' || "recurringTokenRef" FROM payments WHERE id = '${sub.id}'`,
    ),
    '2027-01-01|tok_after',
    'stacked one month onto the live sub',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(name || ':' || "aggregateId", ',') FROM domain_events WHERE "externalUserId" = '${sub.externalUserId}'`,
    ),
    `recurring_payment_succeeded:${sub.id}`,
    'a prolongation, not a new subscription',
  );
};

/** A lapsed intro link for a PastDue contact: refused before any re-mint. */
const t35LapsedIntro = async (http: Http) => {
  await insertSessions([
    plainSession('chk_t35_lapsed', 'sp:t35-lapsed', {
      ...INTRO,
      expiresAt: PAST,
    }),
  ]);
  const res = await pay(http, 'chk_t35_lapsed', PaymentMethod.Card);
  assert.equal(res.status, 409, 'lapsed intro with a PastDue sub → 409');
  assert.equal(res.body['code'], 'already_subscribed');
  assert.equal(await sessionsOf(http, 'sp:t35-lapsed'), '1', 'no re-mint');
};

const t35IntroOnLiveSub: Scenario = {
  name: 'pay (T35): an intro-priced link for a contact with a live sub → 409 already_subscribed (live or lapsed); a non-intro link stacks',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 't35-svc');
    const pastDue = { end: PAST, status: PaymentStatus.PastDue };
    const seeded = await seedSubs([
      { externalUserId: 'sp:t35-active', end: FAR },
      { externalUserId: 'sp:t35-pastdue', ...pastDue },
      { externalUserId: 'sp:t35-lapsed', ...pastDue },
      {
        externalUserId: 'sp:t35-stack',
        end: new Date('2026-12-01T00:00:00Z'),
        period: 'P1M',
      },
    ]);
    await t35IntroRefused(http, 'sp:t35-active');
    await t35IntroRefused(http, 'sp:t35-pastdue');
    const newcomer = await sessionIdOf(
      await createSession(http, { externalUserId: 'sp:t35-none', ...INTRO }),
      'intro for a new contact',
    );
    paidSession(await pay(http, newcomer, PaymentMethod.Card), 'no live sub');
    await t35NonIntroStacks(http, seeded('sp:t35-stack'));
    await t35LapsedIntro(http);
  },
};

// ---------------------------------------------------------------------------------
// Fix round C2 — a live renewal link for a sub that has since died is stale.
// ---------------------------------------------------------------------------------

const C2 = 'sp:c2';

/** A's links: a fresh `/prolong`, one already handed to the provider (Pending), and a
 * manual-renewal link. Then A dies and the contact buys B (crypto, USD, P1M). */
const seedStaleLinks = async (http: Http) => {
  const seeded = await seedSubs([{ externalUserId: C2, end: FAR }]);
  const a = seeded(C2);
  const fresh = await prolongId(http, C2);
  const pending = await prolongId(http, C2);
  paidSession(await pay(http, pending, PaymentMethod.Card), 'A link, Pending');
  await insertSessions([
    manualRenewalSession(a, 'chk_c2_manual', FAR, `manual:${a.id}:1`),
  ]);
  const b = await onDb(
    Effect.gen(function* () {
      const subs = makePaymentRepo(yield* SqlClient.SqlClient);
      yield* subs.markRenewalFailed(a.id);
      return yield* seedSub(subs, {
        externalUserId: C2,
        end: FAR,
        method: PaymentMethod.Crypto,
        token: null,
        currency: 1,
        period: 'P1M',
      });
    }),
  );
  return { b, fresh, pending };
};

/** origin | method | renewalOf | status | period | currency of a session. */
const termsOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT origin || '|' || method || '|' || "renewalOf" || '|' || status || '|' || period || '|' || currency FROM checkout_sessions WHERE id = '${id}'`,
  );

/** Pay B's re-minted session (WhitePay success through the worker). */
const payCrypto = (sessionId: string) =>
  onDb(
    Effect.gen(function* () {
      yield* registerHandlers;
      yield* (yield* ChargePipeline).ingest({
        source: 'whitepay_callback',
        idemKey: `wp:${sessionId}|succeeded`,
        externalRef: sessionId,
        externalUserId: null,
        amount: 30000,
        currency: 1,
        status: 'succeeded',
        occurredAt: new Date(),
        payload: {},
      });
      yield* runFor(2);
    }),
  );

const c2ProlongLink = async (http: Http, b: Payment, fresh: string) => {
  const before = await sessionsOf(http, C2);
  const card = await pay(http, fresh, PaymentMethod.Card);
  assertMethodLocked(card, PaymentMethod.Crypto, "A's link, B is crypto");
  assert.equal(await sessionsOf(http, C2), before, 'nothing written');
  assert.equal(await statusOf(http, fresh), CREATED);
  const crypto = await pay(http, fresh, PaymentMethod.Crypto);
  const remint = paidSession(crypto, "A's link with Crypto");
  assert.notEqual(remint, fresh);
  assert.equal(
    await termsOf(http, remint),
    `prolong|1|${b.id}|${PENDING}|P1M|1`,
    "re-minted at B's terms, locked to Crypto, renewalOf = B",
  );
  await payCrypto(remint);
  assert.equal(
    await scalar(
      http,
      `SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM payments WHERE id = '${b.id}'`,
    ),
    '2030-02-01',
    'paying it stacks B',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(name || ':' || "aggregateId", ',') FROM domain_events WHERE "externalUserId" = '${C2}'`,
    ),
    `recurring_payment_succeeded:${b.id}`,
  );
};

const c2ManualAndPending = async (http: Http, b: Payment, pending: string) => {
  const manual = await pay(http, 'chk_c2_manual', PaymentMethod.Card);
  const remint = paidSession(manual, "A's manual link with Card");
  assert.notEqual(remint, 'chk_c2_manual');
  assert.equal(
    await termsOf(http, remint),
    `manual_renewal|0|${b.id}|${PENDING}|P1M|1`,
    "re-minted at B's terms (not method-locked), renewalOf = B",
  );
  const stale = await pay(http, pending, PaymentMethod.Crypto);
  assert.equal(stale.status, 409, 'a stale link already Pending → 409');
  assert.equal(await statusOf(http, pending), PENDING, 'left as it was');
};

const c2StaleRenewalLink: Scenario = {
  name: "pay (C2): a live renewal link for a dead sub re-mints at the contact's new sub (terms, method, renewalOf); Pending stale → 409",
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'c2-svc');
    const { b, fresh, pending } = await seedStaleLinks(http);
    await withWhitePayApp(async (wpUrl) => {
      const wp = await onApp(http, wpUrl);
      await c2ProlongLink(wp, b, fresh);
      await c2ManualAndPending(wp, b, pending);
    });
  },
};

// ---------------------------------------------------------------------------------
// Provider callbacks with any reference, amount, currency and paid-at instant.
// ---------------------------------------------------------------------------------

/** What a provider reports for one order. `amount` is in major units, as it is sent. */
export interface ProviderOrder {
  readonly ref: string;
  readonly amount: number;
  readonly currency?: string;
  /** The paid-at instant the callback carries (second precision); defaults to now. */
  readonly at?: Date;
}

/** A signed WayForPay callback for `order`, then a worker pass over the queue. */
export const w4pCallback = async (
  http: Http,
  transactionStatus: 'Approved' | 'Declined',
  { ref, amount, currency = 'UAH', at = new Date() }: ProviderOrder,
): Promise<void> => {
  const approved = transactionStatus === 'Approved';
  const res = await postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: ref,
      amount: String(amount),
      currency,
      authCode: '',
      cardPan: '',
      transactionStatus,
      reasonCode: approved ? '' : '1101',
      recToken: approved ? 'tok_w4p' : '',
      createdDate: String(Math.floor(at.getTime() / 1000)),
      transactionType: 'PURCHASE',
    }),
  );
  assert.equal(res.status, 200, `W4P ${transactionStatus} ${ref} accepted`);
  await drainQueue();
};

/** A WhitePay webhook signed with the WhitePay app's token (`withWhitePayApp`), then a
 * worker pass over the queue. */
export const whitePayCallback = async (
  http: Http,
  status: 'COMPLETE' | 'DECLINED',
  { ref, amount, currency = 'USD', at = new Date() }: ProviderOrder,
): Promise<void> => {
  const raw = JSON.stringify({
    order: {
      id: `wp_${ref}`,
      external_order_id: ref,
      value: amount.toFixed(2),
      currency,
      status,
      created_at: at.toISOString(),
      completed_at: at.toISOString(),
    },
  });
  const res = await fetch(`${http.baseUrl}/api/providers/whitepay/callback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      signature: hmacSha256Hex(raw, WHITEPAY_WEBHOOK_TOKEN),
    },
    body: raw,
  });
  assert.equal(res.status, 200, `WhitePay ${status} ${ref} accepted`);
  await drainQueue();
};

/** The card order a 200 `/pay` hands to WayForPay: reference and major-unit amount. */
export const cardOrderOf = (res: PayResult, what: string) => {
  assert.equal(res.status, 200, `${what} → 200`);
  assert.equal(res.body['kind'], 'form', `${what}: a card form`);
  const fields = res.body['fields'] as Json;
  return {
    ref: String(fields['orderReference']),
    amount: Number(fields['amount']),
  };
};

/** [amount, cycles] of every option the public read offers. */
export const cyclesOffered = (read: Json) =>
  (read['options'] as Json[]).map((o) => [o['amount'], o['cycles']]);

/** UTC date of a sub's paid-through end. */
export const endDateOf = (http: Http, subId: string) =>
  scalar(
    http,
    `SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM payments WHERE id = '${subId}'`,
  );

/** Every column of a payments row, as text: the byte-identity check. */
export const rowOf = (http: Http, subId: string) =>
  scalar(http, `SELECT p::text FROM payments p WHERE id = '${subId}'`);

/** name:aggregateId of a contact's events in the order they were stored. Events of one
 * settlement share a transaction (and so `createdAt`); domain_events is insert-only, so
 * `ctid` follows the insert order inside it. */
export const eventsOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT coalesce(string_agg(name || ':' || "aggregateId", ',' ORDER BY "createdAt", ctid), '') FROM domain_events WHERE "externalUserId" = '${contact}'`,
  );

// ---------------------------------------------------------------------------------
// B10 — the on-demand /prolong link offers the configured cycles.
// ---------------------------------------------------------------------------------

const B10 = 'sp:b10';
const B10_END = new Date('2026-12-01T00:00:00Z');

/** Three cycles of the sub's P4W stacked once on Dec 1, one recurring success. */
const assertStackedThreeOnce = async (http: Http, sub: Payment) => {
  assert.equal(await endDateOf(http, sub.id), '2027-02-23', '3 x P4W on Dec 1');
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(name || ':' || "aggregateId" || ':' || (payload->>'cycles') || ':' || (payload->>'amount'), ',') FROM domain_events WHERE "externalUserId" = '${B10}'`,
    ),
    `recurring_payment_succeeded:${sub.id}:3:90000`,
    'one recurring success for 3 cycles at 3x',
  );
};

/** A session's claimedAt as epoch ms, or 'null' when it was never claimed. */
const claimedAtMs = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT coalesce(round(extract(epoch FROM "claimedAt") * 1000)::bigint::text, 'null') FROM checkout_sessions WHERE id = '${id}'`,
  );

/** `/pay` option 1 on an unclaimed link: `_c3` at 3x, and claimedAt stamped by this
 * request, before any callback. */
const payC3Claimed = async (http: Http, id: string) => {
  assert.equal(await claimedAtMs(http, id), 'null', 'never claimed: NULL');
  const before = Date.now();
  const paid = await pay(http, id, PaymentMethod.Card, 1);
  const after = Date.now();
  const order = cardOrderOf(paid, 'c3');
  assert.deepEqual(order, { ref: `${id}_c3`, amount: 900 }, '_c3 at 3x');
  // Stamped by this /pay, before any callback: inside the request interval (±1 ms for
  // the timestamptz round trip).
  const claimedAt = Number(await claimedAtMs(http, id));
  assert.ok(
    claimedAt >= before - 1 && claimedAt <= after + 1,
    `claimedAt ${String(claimedAt)} within /pay [${String(before)}, ${String(after)}]`,
  );
  return order;
};

const b10Cycles = async (http: Http, sub: Payment) => {
  const id = await sessionIdOf(
    await callProlong(http, B10, 'k-b10'),
    'prolong',
  );
  const replay = await callProlong(http, B10, 'k-b10');
  assert.equal(await sessionIdOf(replay, 'replay'), id, 'same key → same id');
  const read = await publicRead(http, id);
  assert.equal(read['prolong'], true, 'still a prolong page');
  assert.equal(read['methodLocked'], true);
  assert.deepEqual(cyclesOffered(read), [
    [30000, 1],
    [90000, 3],
    [180000, 6],
  ]);
  const crypto = await pay(http, id, PaymentMethod.Crypto, 1);
  assertMethodLocked(crypto, PaymentMethod.Card, 'Crypto on a card prolong');
  assert.equal(await statusOf(http, id), CREATED, 'nothing claimed');
  const order = await payC3Claimed(http, id);
  await w4pCallback(http, 'Approved', order);
  // A redelivered callback (same order, same status) must not stack again.
  await w4pCallback(http, 'Approved', order);
  await assertStackedThreeOnce(http, sub);
};

const b10ProlongCycles: Scenario = {
  name: 'prolong (B10): with MANUAL_RENEWAL_CYCLE_OPTIONS=1,3,6 the on-demand link offers 1/3/6; option 1 pays _c3 at 3x and stacks 3 periods once; method lock and key replay unchanged',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'b10-svc');
    const subOf = await seedSubs([{ externalUserId: B10, end: B10_END }]);
    await withWhitePayApp(
      async (url) => {
        await b10Cycles(await onApp(http, url), subOf(B10));
      },
      { MANUAL_RENEWAL_CYCLE_OPTIONS: '1,3,6' },
    );
  },
};

export const prolongScenarios: readonly Scenario[] = [
  t20ProlongEndpoint,
  t31MethodLock,
  t31CryptoAndRemint,
  t35IntroOnLiveSub,
  c2StaleRenewalLink,
  b10ProlongCycles,
];
