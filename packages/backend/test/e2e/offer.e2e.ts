import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import { CheckoutSessionStatus, PaymentMethod } from '@billing-service/shared';
import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';

import { loadBffHandler, makeBff, type Scenario } from './http-harness.js';
import {
  cardOrderOf,
  createSession,
  type Http,
  httpContext,
  insertSessions,
  type Json,
  onDb,
  pay,
  plainSession,
  publicRead,
  scalar,
  sessionIdOf,
  sessionsOf,
  w4pCallback,
  withEnv,
} from './prolong.e2e.js';

/**
 * HTTP e2e for the offer fields of a caller's checkout: `startsAt` (where a fresh
 * subscription's period begins), `payableUntil` (a bounded offer, closed with a 410 and
 * never re-issued), `lockMethod`, the service-token read of a session, and the
 * `checkoutSessionId` a checkout success reports.
 */

const DAY = 24 * 60 * 60 * 1000;

const body = (contact: string, extra: Json = {}): Json => ({
  externalUserId: contact,
  amount: 30000,
  currency: 0,
  period: 'P1M',
  ...extra,
});

const millisOf = (http: Http, sql: string) =>
  scalar(http, `SELECT (extract(epoch FROM (${sql})) * 1000)::bigint`);

const STARTS = 'sp:offer-starts';

/** A checkout with `startsAt` ten days out, paid now: the fresh row starts there. */
const startsLater = async (http: Http) => {
  const startsAt = new Date(Date.now() + 10 * DAY);
  const id = await sessionIdOf(
    await createSession(
      http,
      body(STARTS, { startsAt: startsAt.toISOString() }),
    ),
    'create with startsAt',
  );
  assert.equal(
    (await publicRead(http, id))['startsAt'],
    startsAt.toISOString(),
    'the public read discloses startsAt',
  );
  const order = cardOrderOf(await pay(http, id, PaymentMethod.Card), 'pay');
  await w4pCallback(http, 'Approved', order);
  assert.equal(
    await millisOf(
      http,
      `SELECT "currentPeriodStart" FROM payments WHERE "externalUserId" = '${STARTS}'`,
    ),
    String(startsAt.getTime()),
    'the period starts at startsAt, not at the payment',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT ("nextPaymentDate" = "currentPeriodEnd" AND "currentPeriodEnd" = ("currentPeriodStart" AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')::text FROM payments WHERE "externalUserId" = '${STARTS}'`,
    ),
    'true',
    'a full month from startsAt, the next charge on its end',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT payload->>'checkoutSessionId' FROM domain_events WHERE name = 'initial_payment_succeeded' AND "externalUserId" = '${STARTS}'`,
    ),
    id,
    'the success names the session that settled it',
  );
};

/** The schedule bounds are 422s, and a replay may not move startsAt. */
const startsAtRefusals = async (http: Http) => {
  const past = new Date(Date.now() - DAY).toISOString();
  const tooFar = new Date(Date.now() + 63 * DAY).toISOString();
  for (const extra of [
    { startsAt: past },
    { startsAt: tooFar },
    { payableUntil: past },
    { payableUntil: tooFar },
  ]) {
    const res = await createSession(http, body('sp:offer-bounds', extra));
    assert.equal(res.status, 422, `${JSON.stringify(extra)} → 422`);
  }
  const key = 'offer-replay';
  const first = new Date(Date.now() + DAY).toISOString();
  const second = new Date(Date.now() + 2 * DAY).toISOString();
  await sessionIdOf(
    await createSession(
      http,
      body('sp:offer-replay', { startsAt: first }),
      key,
    ),
    'first create',
  );
  const replay = await createSession(
    http,
    body('sp:offer-replay', { startsAt: second }),
    key,
  );
  assert.equal(replay.status, 409, 'a replay with another startsAt → 409');
};

/** A retry under the same key after both instants passed replays, it is not a 422. */
const replayAfterLapse = async (http: Http) => {
  const request = body('sp:offer-late-retry', {
    startsAt: new Date(Date.now() + 1500).toISOString(),
    payableUntil: new Date(Date.now() + 2000).toISOString(),
  });
  const first = await sessionIdOf(
    await createSession(http, request, 'offer-late-retry'),
    'first create',
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const retry = await sessionIdOf(
    await createSession(http, request, 'offer-late-retry'),
    'identical retry after both instants passed',
  );
  assert.equal(retry, first, 'the same session');
};

const startsAtScenario: Scenario = {
  name: 'offer: startsAt anchors a fresh subscription and its success names the session; bounds are 422, a replay moving it 409',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'offer-starts-svc');
    await startsLater(http);
    await startsAtRefusals(http);
    await replayAfterLapse(http);
  },
};

const BOUNDED = 'sp:offer-bounded';

const boundedOffer = async (http: Http) => {
  const closesAt = new Date(Date.now() + DAY);
  const res = await createSession(
    http,
    body(BOUNDED, { payableUntil: closesAt.toISOString() }),
  );
  assert.equal(res.status, 201, 'create bounded');
  const created = (await res.json()) as Json;
  assert.equal(
    created['expiresAt'],
    closesAt.toISOString(),
    'a bounded offer expires when it closes',
  );
  const lapsed = new Date(Date.now() - 60_000);
  await insertSessions([
    plainSession('chk_offer_closed', BOUNDED, {
      payableUntil: lapsed,
      expiresAt: lapsed,
    }),
  ]);
  const before = await sessionsOf(http, BOUNDED);
  const paid = await pay(http, 'chk_offer_closed', PaymentMethod.Card);
  assert.deepEqual(paid, {
    status: 410,
    body: { error: 'this checkout is closed', code: 'checkout_closed' },
  });
  assert.equal(
    await sessionsOf(http, BOUNDED),
    before,
    'a closed offer is never re-issued',
  );
};

const lockedMethod = async (http: Http) => {
  const unnamed = await createSession(
    http,
    body('sp:offer-lock', { lockMethod: true }),
  );
  assert.equal(unnamed.status, 400, 'lockMethod without method → 400');
  const id = await sessionIdOf(
    await createSession(
      http,
      body('sp:offer-lock', { lockMethod: true, method: PaymentMethod.Card }),
    ),
    'create locked',
  );
  assert.equal((await publicRead(http, id))['methodLocked'], true);
  const res = await pay(http, id, PaymentMethod.Crypto);
  assert.equal(res.status, 400, 'another method → 400');
  assert.equal(res.body['code'], 'method_locked');
  assert.equal(
    await scalar(
      http,
      `SELECT status FROM checkout_sessions WHERE id = '${id}'`,
    ),
    String(CheckoutSessionStatus.Created),
    'nothing claimed',
  );
};

/** A row claimed before `firstSentToProviderAt` existed, then released: still sent. */
const releasedPreUpgrade = async (http: Http) => {
  await insertSessions([plainSession('chk_offer_preupgrade', 'sp:offer-pre')]);
  await scalar(
    http,
    `UPDATE checkout_sessions SET status = ${String(CheckoutSessionStatus.Pending)}, "claimedAt" = now(), "firstSentToProviderAt" = NULL WHERE id = 'chk_offer_preupgrade'`,
  );
  await onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).releasePending('chk_offer_preupgrade'),
    ),
  );
  const read = await publicRead(http, 'chk_offer_preupgrade');
  assert.equal(read['status'], CheckoutSessionStatus.Created);
  assert.equal(read['everSentToProvider'], true, 'released, still sent');
};

const boundedScenario: Scenario = {
  name: 'offer: payableUntil sets expiresAt, a lapsed bounded offer is 410 with no new session; lockMethod refuses another method',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'offer-bounded-svc');
    await boundedOffer(http);
    await lockedMethod(http);
    await releasedPreUpgrade(http);
  },
};

const read = (url: string, headers: Record<string, string>) =>
  fetch(url, { headers });

/** With the BFF gate on: the BFF and a service token read the same body; nothing else. */
const serviceRead = async (http: Http, baseUrl: string) => {
  const id = await sessionIdOf(
    await createSession({ ...http, baseUrl }, body('sp:offer-read')),
    'create',
  );
  const url = `${baseUrl}/api/checkout-sessions/${id}`;
  const bearer = { authorization: `Bearer ${http.secret}` };
  const viaService = (await (await read(url, bearer)).json()) as Json;
  const bff = makeBff(await loadBffHandler(), baseUrl);
  const viaBff = (await (
    await bff(new Request(`${baseUrl}/api/checkout-sessions/${id}`))
  ).json()) as Json;
  assert.deepEqual(viaService, viaBff, 'the same body either way');
  assert.equal(viaService['status'], CheckoutSessionStatus.Created);
  assert.equal(viaService['everSentToProvider'], false);
  assert.equal(typeof viaService['expiresAt'], 'string');
  await refusedAndSent({ ...http, baseUrl, bff }, url, bearer);
};

/** No credential or a bad one is refused; after Pay the read reports the hand-off. */
const refusedAndSent = async (
  http: Http,
  url: string,
  bearer: Record<string, string>,
) => {
  assert.equal((await read(url, {})).status, 401, 'no credential → 401');
  assert.equal(
    (await read(url, { authorization: 'Bearer nope' })).status,
    401,
    'an invalid token → 401',
  );
  const id = url.slice(url.lastIndexOf('/') + 1);
  await pay(http, id, PaymentMethod.Card);
  const sent = (await (await read(url, bearer)).json()) as Json;
  assert.equal(sent['status'], CheckoutSessionStatus.Pending);
  assert.equal(sent['everSentToProvider'], true, 'claimed for payment');
  // Released (as a failed crypto mint or a re-press does) and never re-claimed: the
  // status is back to Created, yet the order was handed out.
  await onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).releasePending(id),
    ),
  );
  const released = (await (await read(url, bearer)).json()) as Json;
  assert.equal(released['status'], CheckoutSessionStatus.Created);
  assert.equal(released['everSentToProvider'], true, 'released, still sent');
};

const serviceReadScenario: Scenario = {
  name: 'offer: GET a session with the service token, the same body as the BFF; 401 without a credential or with a bad one',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'offer-read-svc');
    await withEnv({ BFF_SECRET: 'e2e-bff-secret' }, async () => {
      const app = await buildApp();
      try {
        await serviceRead(
          http,
          await app.listen({ host: '127.0.0.1', port: 0 }),
        );
      } finally {
        await app.close();
      }
    });
  },
};

export const offerScenarios: readonly Scenario[] = [
  startsAtScenario,
  boundedScenario,
  serviceReadScenario,
];
