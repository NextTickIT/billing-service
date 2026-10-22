import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { type Payment, PaymentMethod } from '@billing-service/shared';

import {
  cycleOptions,
  manualRenewalSession,
} from '@/modules/checkout/domain.js';

import {
  MERCHANT_ACCOUNT,
  postJson,
  type Scenario,
  signCallback,
} from './http-harness.js';
import {
  createSession,
  drainQueue,
  FAR,
  type Http,
  httpContext,
  insertSessions,
  type Json,
  publicRead,
  scalar,
  seedSubs,
  sessionIdOf,
} from './prolong.e2e.js';

/**
 * HTTP e2e for checkout options: a caller's options and the manual renewal's cycles,
 * from the public read through `/pay` and a signed WayForPay callback to the stored
 * subscription and its event.
 */

interface CardOrder {
  readonly orderReference: string;
  readonly amount: number;
}

/** Pay by card with an option; the order the signed form hands to WayForPay. */
const payCard = async (
  http: Http,
  id: string,
  option: number,
): Promise<CardOrder> => {
  const res = await http.bff(
    new Request(`${http.baseUrl}/api/checkout-sessions/${id}/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: PaymentMethod.Card, option }),
    }),
  );
  assert.equal(res.status, 200, `pay ${id} option ${String(option)} → 200`);
  const fields = ((await res.json()) as { fields: Json }).fields;
  return {
    orderReference: String(fields['orderReference']),
    amount: Number(fields['amount']),
  };
};

/** WayForPay approves `order`; the ack must sign the reference exactly as sent. */
const approve = async (http: Http, order: CardOrder) => {
  const res = await postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: order.orderReference,
      amount: String(order.amount),
      currency: 'UAH',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: '',
      recToken: 'tok_options',
      createdDate: '1700000000',
      transactionType: 'PURCHASE',
    }),
  );
  assert.equal(res.status, 200, 'callback accepted');
  const ack = (await res.json()) as Json;
  assert.equal(ack['orderReference'], order.orderReference, 'ack: raw ref');
  await drainQueue();
};

const succeededPayload = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT payload->>'amount' || '|' || (payload->>'period') || '|' || coalesce(payload->>'cycles', '-')
       FROM domain_events WHERE "externalUserId" = '${contact}' AND name LIKE '%_succeeded'`,
  );

const CALLER = 'sp:options-caller';

/** Create a session offering 4 weeks (the default) or 12 weeks; check its public read. */
const createWithOptions = async (http: Http): Promise<string> => {
  const flat = { amount: 5000, period: 'P4W' };
  const threeCycles = {
    amount: 13000,
    period: 'P12W',
    renewal: { amount: 5000, period: 'P4W' },
  };
  const body = {
    externalUserId: CALLER,
    currency: 0,
    ...flat,
    options: [flat, threeCycles],
  };
  const notListed = await createSession(http, {
    ...body,
    options: [threeCycles],
  });
  assert.equal(notListed.status, 400, 'flat terms not among the options → 400');
  const id = await sessionIdOf(await createSession(http, body), 'create');
  const read = await publicRead(http, id);
  assert.equal(read['defaultOption'], 0);
  assert.deepEqual(
    (read['options'] as Json[]).map((o) => [o['amount'], o['period']]),
    [
      [5000, 'P4W'],
      [13000, 'P12W'],
    ],
  );
  return id;
};

const callerOptions = async (http: Http) => {
  const id = await createWithOptions(http);
  const picked = await payCard(http, id, 1);
  assert.deepEqual(picked, { orderReference: `${id}_o1`, amount: 130 });
  // Back and pick the default: its own reference, so WayForPay never sees one
  // reference at two amounts.
  const back = await payCard(http, id, 0);
  assert.deepEqual(back, { orderReference: id, amount: 50 });
  await approve(http, await payCard(http, id, 1));
  assert.equal(
    await scalar(
      http,
      `SELECT amount || '|' || period || '|' || ("currentPeriodEnd" - "currentPeriodStart" = interval '84 days')
         FROM payments WHERE "externalUserId" = '${CALLER}'`,
    ),
    '5000|P4W|true',
    'the option bought 12 weeks; the sub renews at its renewal terms',
  );
  assert.equal(await succeededPayload(http, CALLER), '13000|P12W|-');
};

const callerOptionsScenario: Scenario = {
  name: "options: a caller option is read, paid under its own reference, and settles with that option's terms",
  run: async ({ baseUrl, query }) => {
    await callerOptions(await httpContext(baseUrl, query, 'options-svc'));
  },
};

const MANUAL = 'sp:options-manual';
const END = new Date('2026-12-01T00:00:00Z');

const manualCycles = async (http: Http, sub: Payment) => {
  const id = `chk_${randomUUID()}`;
  await insertSessions([
    {
      ...manualRenewalSession(sub, id, FAR, `manual:${sub.id}:1`),
      options: cycleOptions([1, 3, 6]),
    },
  ]);
  const read = await publicRead(http, id);
  assert.deepEqual(
    (read['options'] as Json[]).map((o) => [o['amount'], o['cycles']]),
    [
      [30000, 1],
      [90000, 3],
      [180000, 6],
    ],
  );
  const order = await payCard(http, id, 1);
  assert.deepEqual(order, { orderReference: `${id}_c3`, amount: 900 });
  await approve(http, order);
  assert.equal(
    await scalar(
      http,
      `SELECT amount || '|' || period || '|' || to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
         FROM payments WHERE id = '${sub.id}'`,
    ),
    '30000|P4W|2027-02-23',
    'three P4W stacked on Dec 1; the sub keeps its base amount and period',
  );
  assert.equal(await succeededPayload(http, MANUAL), '90000|P12W|3');
};

const manualCyclesScenario: Scenario = {
  name: 'options: a 3-cycle manual renewal charges 3x, stacks 3 periods, keeps the base terms',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cycles-svc');
    const subOf = await seedSubs([
      {
        externalUserId: MANUAL,
        end: END,
        method: PaymentMethod.Crypto,
        token: null,
      },
    ]);
    await manualCycles(http, subOf(MANUAL));
  },
};

export const optionsScenarios: readonly Scenario[] = [
  callerOptionsScenario,
  manualCyclesScenario,
];
