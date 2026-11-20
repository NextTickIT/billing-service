import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import { PaymentMethod, PaymentStatus } from '@billing-service/shared';
import { Effect } from 'effect';

import { makePaymentRepo } from '@/modules/payment/data-access.js';

import {
  MERCHANT_ACCOUNT,
  postJson,
  type Scenario,
  signCallback,
} from './http-harness.js';
import {
  createSession,
  drainQueue,
  type Http,
  httpContext,
  type Json,
  onDb,
  scalar,
  seedSubs,
  sessionIdOf,
} from './prolong.e2e.js';

/**
 * HTTP e2e for `POST /api/payment/apply-offer`: a Black Friday recurring subscription paid
 * by card through the real checkout and a signed WayForPay callback (or seeded through the
 * production repo), then applied to a contact with the service token, as the CRM does.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const bfMetadata = (extendDays: unknown) => ({
  campaign: 'bf2026',
  offer: 'bf5',
  extend_days: extendDays,
  source: 'e2e',
});

const apply = (
  http: Http,
  body: Json,
  key: string | null = randomUUID(),
  bearer: string | null = http.secret,
) =>
  postJson(`${http.baseUrl}/api/payment/apply-offer`, body, {
    ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    ...(key === null ? {} : { 'idempotency-key': key }),
  });

const answerOf = async (res: Response, what: string): Promise<Json> => {
  assert.equal(res.status, 200, `${what} → 200`);
  return (await res.json()) as Json;
};

/** A paid bf5 card checkout under a fresh buyer id, as the CRM issues it: recurring,
 * P22W at $250, renewing at $50 / P4W. WayForPay returns `recToken`. */
const buyByCard = async (http: Http, recToken: string): Promise<string> => {
  const buyer = randomUUID();
  const id = await sessionIdOf(
    await createSession(http, {
      externalUserId: buyer,
      amount: 25000,
      currency: 1,
      period: 'P22W',
      renewal: { amount: 5000, period: 'P4W' },
      metadata: bfMetadata('154'),
    }),
    `create ${buyer}`,
  );
  const pay = await http.bff(
    new Request(`${http.baseUrl}/api/checkout-sessions/${id}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: PaymentMethod.Card }),
    }),
  );
  assert.equal(pay.status, 200, `pay ${id} → 200`);
  const callback = await postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: id,
      amount: '250',
      currency: 'USD',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: '',
      recToken,
      createdDate: '1700000000',
      transactionType: 'PURCHASE',
    }),
  );
  assert.equal(callback.status, 200, 'callback accepted');
  await drainQueue();
  return buyer;
};

/** A paid bf payment seeded as the checkout applier writes it. */
const seedPurchase = async (
  extendDays: unknown,
  recurring = true,
  buyer: string = randomUUID(),
): Promise<string> => {
  const now = new Date();
  const end = new Date(now.getTime() + 154 * DAY_MS);
  await onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makePaymentRepo(sql).insert({
        externalUserId: buyer,
        amount: 5000,
        currency: 1,
        method: PaymentMethod.Card,
        period: 'P4W',
        status: PaymentStatus.Active,
        recurring,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        nextPaymentDate: end,
        recurringTokenRef: recurring ? 'tok_seeded' : null,
        firstFailureAt: null,
        retryAttempt: 0,
        metadata: bfMetadata(extendDays),
      }),
    ),
  );
  return buyer;
};

/** owner | status | applied-to of the buyer's bf payment, found by its marker. */
const purchaseOf = (http: Http, buyer: string) =>
  scalar(
    http,
    `SELECT "externalUserId" || '|' || status || '|' || coalesce("campaignApplied"->>'externalUserId', '-')
       FROM payments WHERE metadata->>'campaign' = 'bf2026'
        AND ("externalUserId" = '${buyer}' OR "campaignApplied"->>'buyerId' = '${buyer}')`,
  );

const activeSubsOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT count(*) FROM payments WHERE "externalUserId" = '${contact}' AND recurring AND status = 0`,
  );

const MEMBER = '64b7f0c2a1d3e4f5a6b7c801';
const MEMBER_END = new Date('2026-12-20T00:00:00Z');
const CANCELLED = String(PaymentStatus.Cancelled);

const assertMemberRecords = async (
  http: Http,
  subId: string,
  buyer: string,
) => {
  assert.equal(
    await scalar(
      http,
      `SELECT actor || '|' || (detail->>'days') || '|' || (detail->>'reason')
         FROM audit_log WHERE action = 'defer_payment' AND "targetId" = '${subId}'`,
    ),
    'service|154|campaign',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT (payload->>'externalUserId') || ':' || (payload->>'days') || ':' || (payload->>'reason')
         FROM messages WHERE "messageType" = 'payment_defer'`,
    ),
    `${MEMBER}:154:campaign`,
    'the defer notify carries the member, the days and the reason',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT (payload->>'from') || '>' || (payload->>'to') || ':' || (payload->>'movedPayments')
         FROM messages WHERE "messageType" = 'external_user_id_change'`,
    ),
    `${buyer}>${MEMBER}:1`,
    'the rebind notify links the money to the member',
  );
};

const extendsMember = async (http: Http) => {
  const subOf = await seedSubs([{ externalUserId: MEMBER, end: MEMBER_END }]);
  const buyer = await buyByCard(http, 'tok_bf_member');
  const expectedEnd = new Date(MEMBER_END.getTime() + 154 * DAY_MS);

  const answer = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: MEMBER }),
    'apply to a member',
  );

  assert.deepEqual(answer, {
    result: 'extended',
    paymentId: subOf(MEMBER).id,
    periodEnd: expectedEnd.toISOString(),
    nextPaymentDate: expectedEnd.toISOString(),
    nextPaymentDate_formatted: '23.05.2027',
  });
  assert.equal(
    await scalar(
      http,
      `SELECT ("currentPeriodEnd" = '${expectedEnd.toISOString()}') || '|' || ("nextPaymentDate" = '${expectedEnd.toISOString()}') || '|' || "recurringTokenRef"
         FROM payments WHERE id = '${subOf(MEMBER).id}'`,
    ),
    'true|true|tok_old',
    'both dates +154 days; the member keeps their own card',
  );
  assert.equal(
    await purchaseOf(http, buyer),
    `${MEMBER}|${CANCELLED}|${MEMBER}`,
    'the bf subscription is moved to the member and cancelled: it never charges',
  );
  assert.equal(await activeSubsOf(http, MEMBER), '1');
  await assertMemberRecords(http, subOf(MEMBER).id, buyer);
  return { buyer, answer };
};

/** A new key for the same apply answers the same; the days are added once. */
const replays = async (http: Http, buyer: string, first: Json) => {
  const again = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: MEMBER }),
    'same apply, new key',
  );

  assert.deepEqual(again, first);
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM audit_log WHERE action = 'defer_payment'`,
    ),
    '1',
    'the days were added once',
  );
};

const refusals = async (http: Http, buyer: string) => {
  const elsewhere = await apply(http, {
    buyerId: buyer,
    externalUserId: '64b7f0c2a1d3e4f5a6b7c8ff',
  });
  const unknown = await apply(http, {
    buyerId: randomUUID(),
    externalUserId: MEMBER,
  });
  const noToken = await apply(
    http,
    { buyerId: buyer, externalUserId: MEMBER },
    randomUUID(),
    null,
  );
  const noKey = await apply(
    http,
    { buyerId: buyer, externalUserId: MEMBER },
    null,
  );
  const notUuid = await apply(http, {
    buyerId: `bf-${buyer}`,
    externalUserId: MEMBER,
  });

  assert.equal(elsewhere.status, 409, 'applied to another contact → 409');
  assert.equal(((await elsewhere.json()) as Json)['code'], 'conflict');
  assert.equal(unknown.status, 404, 'unknown buyer → 404');
  assert.equal(noToken.status, 401, 'no service token → 401');
  assert.equal(noKey.status, 422, 'no Idempotency-Key → 422');
  assert.equal(notUuid.status, 422, 'buyerId not a UUID → 422');
  assert.equal(
    await purchaseOf(http, buyer),
    `${MEMBER}|${CANCELLED}|${MEMBER}`,
  );
};

const memberScenario: Scenario = {
  name: 'apply-offer: a card bf purchase extends a member (+154 d, audit, notify, rebind) and is cancelled; replays; 409/404/401/422',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'bf-svc');
    const { buyer, answer } = await extendsMember(http);
    await replays(http, buyer, answer);
    await refusals(http, buyer);
  },
};

const NEWCOMER = '64b7f0c2a1d3e4f5a6b7c802';

const movesToNewcomer = async (http: Http) => {
  const buyer = await buyByCard(http, 'tok_bf_new');

  const answer = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: NEWCOMER }),
    'apply to a newcomer',
  );

  assert.equal(answer['result'], 'created');
  assert.equal(
    await scalar(
      http,
      `SELECT id || '|' || amount || '|' || period || '|' || "recurringTokenRef" || '|'
              || ("currentPeriodEnd" = '${String(answer['periodEnd'])}')
         FROM payments WHERE "externalUserId" = '${NEWCOMER}' AND recurring AND status = 0`,
    ),
    `${String(answer['paymentId'])}|5000|P4W|tok_bf_new|true`,
    'the bf subscription itself is now theirs: $50 / P4W on the purchase card',
  );
  assert.equal(
    await purchaseOf(http, buyer),
    `${NEWCOMER}|${String(PaymentStatus.Active)}|${NEWCOMER}`,
  );
};

const newcomerScenario: Scenario = {
  name: 'apply-offer: a card bf purchase moves to a newcomer as their subscription, with its card token',
  run: async ({ baseUrl, query }) => {
    await movesToNewcomer(await httpContext(baseUrl, query, 'bf-new-svc'));
  },
};

const PAST_DUE = '64b7f0c2a1d3e4f5a6b7c803';

const replacesPastDue = async (http: Http) => {
  const subOf = await seedSubs([
    {
      externalUserId: PAST_DUE,
      end: new Date(Date.now() - 2 * DAY_MS),
      status: PaymentStatus.PastDue,
    },
  ]);
  const buyer = await seedPurchase('154');

  const answer = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: PAST_DUE }),
    'apply to a past-due contact',
  );

  assert.equal(answer['result'], 'created');
  assert.equal(
    await scalar(
      http,
      `SELECT status FROM payments WHERE id = '${subOf(PAST_DUE).id}'`,
    ),
    CANCELLED,
    'the unpaid sub stops dunning the card',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT actor || '|' || (detail->>'reason') FROM audit_log
        WHERE action = 'cancel_payment' AND "targetId" = '${subOf(PAST_DUE).id}'`,
    ),
    'service|campaign',
  );
  assert.equal(
    await purchaseOf(http, buyer),
    `${PAST_DUE}|${String(PaymentStatus.Active)}|${PAST_DUE}`,
  );
};

const refusesBadPurchases = async (http: Http) => {
  const oneTime = await seedPurchase('154', false);
  const broken = await seedPurchase('forever');

  const notRecurring = await apply(http, {
    buyerId: oneTime,
    externalUserId: '64b7f0c2a1d3e4f5a6b7c804',
  });
  const badDays = await apply(http, {
    buyerId: broken,
    externalUserId: '64b7f0c2a1d3e4f5a6b7c805',
  });

  assert.equal(notRecurring.status, 409, 'a one-time bf payment → 409');
  assert.equal(((await notRecurring.json()) as Json)['code'], 'not_recurring');
  assert.equal(badDays.status, 422, 'extend_days not a number → 422');
  assert.equal(await purchaseOf(http, oneTime), `${oneTime}|0|-`);
  assert.equal(await purchaseOf(http, broken), `${broken}|0|-`);
};

const pastDueScenario: Scenario = {
  name: 'apply-offer: a past-due contact sub is cancelled and the purchase becomes theirs; one-time → 409 not_recurring; bad extend_days → 422',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'bf-pd-svc');
    await replacesPastDue(http);
    await refusesBadPurchases(http);
  },
};

const TWICE = '64b7f0c2a1d3e4f5a6b7c806';

/** One buyer id (the CRM reuses it per email) buys twice; each purchase is applied
 * exactly once over three calls with fresh keys. */
const twoPurchases = async (http: Http) => {
  const buyer = await seedPurchase('154');
  const first = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: TWICE }),
    'first purchase',
  );
  await seedPurchase('364', true, buyer);
  const firstEnd = new Date(String(first['periodEnd']));

  const second = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: TWICE }),
    'second purchase',
  );
  const third = await answerOf(
    await apply(http, { buyerId: buyer, externalUserId: TWICE }),
    'nothing left to apply',
  );

  assert.equal(first['result'], 'created', 'the first purchase is theirs');
  assert.deepEqual(
    [second['result'], second['paymentId'], second['periodEnd']],
    [
      'extended',
      first['paymentId'],
      new Date(firstEnd.getTime() + 364 * DAY_MS).toISOString(),
    ],
    'the second purchase adds its days to the first',
  );
  assert.deepEqual(third, second, 'a third call replays the latest result');
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM audit_log WHERE action = 'defer_payment'`,
    ),
    '1',
    'the days were added once more, never again',
  );
  assert.equal(await activeSubsOf(http, TWICE), '1');
};

const twoPurchasesScenario: Scenario = {
  name: 'apply-offer: two purchases under one buyer id, three calls — each applied exactly once',
  run: async ({ baseUrl, query }) => {
    await twoPurchases(await httpContext(baseUrl, query, 'bf-twice-svc'));
  },
};

export const campaignScenarios: readonly Scenario[] = [
  twoPurchasesScenario,
  memberScenario,
  newcomerScenario,
  pastDueScenario,
];
