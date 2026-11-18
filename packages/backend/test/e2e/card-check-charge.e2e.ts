import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { SqlClient } from '@effect/sql';
import { PaymentMethod } from '@billing-service/shared';
import { Deferred, Effect, Fiber } from 'effect';

import { loadConfig } from '@/config.js';
import { enqueue } from '@/infra/queue/store.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  drain,
  type OnWorker,
  registerHandlers,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import {
  CARD_CHECK_REFUND,
  CARD_CHECK_REFUND_MAX_ATTEMPTS,
  CARD_CHECK_REFUND_RECONCILE_ATTEMPTS,
  cardCheckRefundHandler,
  sweepOwedRefunds,
} from '@/modules/checkout/card-check-refund.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { WayForPay } from '@/modules/wayforpay/client.js';
import { mapTransaction } from '@/modules/wayforpay/mapping.js';
import { VERIFY_CHARGE_PRODUCT_NAME } from '@/modules/wayforpay/purchase.js';

import {
  MERCHANT_ACCOUNT,
  postJson,
  type Scenario,
  signCallback,
} from './http-harness.js';
import {
  cardCheckBody,
  close,
  paymentsOf,
  seedPayment,
  statusAndReason,
  withCardCheckApp,
} from './card-check.e2e.js';
import {
  createSession,
  eventsOf,
  type Http,
  httpContext,
  type Json,
  pay,
  publicRead,
  scalar,
  sessionIdOf,
  withEnv,
} from './prolong.e2e.js';

/**
 * HTTP e2e for the `charge_refund` card check (plan wfp-card-check-charge-refund): the
 * create rules and echo, the 1 USD Purchase form, activation on the approved charge with
 * the plan's first charge still at `startsAt`, and the refund every approved verify charge
 * owes — once, whatever the outcome — through the real WayForPay client against a local
 * REFUND endpoint. The provider's own refund row is swallowed by the card-check step.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const CHARGE_REFUND_ON = { W4P_CARD_CHECK_CHARGE_REFUND_ENABLED: 'true' };
const chargeRefundBody = (contact: string, extra: Json = {}): Json =>
  cardCheckBody(contact, { cardCheckMethod: 'charge_refund', ...extra });

/** What the local WayForPay API answers a REFUND with, per order reference. */
type RefundReply = 'refunded' | 'declined' | 'garbage';

/** A local WayForPay `/api`: REFUND answers as told, CHECK_STATUS reports the order
 * still Approved; every body is recorded. */
const w4pEndpoint = async (
  reply: (ref: string) => RefundReply,
  orderStatus: () => string = () => 'Approved',
) => {
  const bodies: Record<string, unknown>[] = [];
  const answer = (body: Record<string, unknown>): string => {
    const ref = String(body['orderReference']);
    if (body['transactionType'] !== 'REFUND') {
      if (orderStatus() === 'garbage') return 'not json';
      return JSON.stringify({
        reasonCode: 1100,
        transactionStatus: orderStatus(),
      });
    }
    switch (reply(ref)) {
      case 'refunded':
        return JSON.stringify({
          orderReference: ref,
          transactionStatus: 'Refunded',
          reasonCode: 1100,
        });
      case 'declined':
        return JSON.stringify({
          orderReference: ref,
          transactionStatus: 'Declined',
          reasonCode: 1112,
        });
      case 'garbage':
        return 'not json';
    }
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const refunds = (ref: string) =>
    bodies.filter(
      (b) => b['transactionType'] === 'REFUND' && b['orderReference'] === ref,
    );
  const calls = (ref: string) =>
    bodies.filter((b) => b['orderReference'] === ref).length;
  return {
    refunds,
    calls,
    server,
    url: `http://127.0.0.1:${port.toString()}/api`,
  };
};

type Endpoint = Awaited<ReturnType<typeof w4pEndpoint>>;

/** The worker's handlers plus the refund task, on the worker's real WayForPay client. */
const registerWithRefund = Effect.gen(function* () {
  yield* registerHandlers;
  const registry = yield* TaskRegistry;
  yield* registry.register(
    CARD_CHECK_REFUND,
    cardCheckRefundHandler({
      sql: yield* SqlClient.SqlClient,
      client: yield* WayForPay,
      publish: (yield* Outbox).publish,
    }),
  );
});

/** A card-check app and one worker, both on the local WayForPay endpoint. */
const withChargeRefund = async (
  http: Http,
  endpoint: Endpoint,
  body: (on: Http, run: OnWorker) => Promise<void>,
): Promise<void> => {
  await withCardCheckApp(
    http,
    (on) =>
      withEnv({ W4P_API_URL: endpoint.url }, () =>
        withWorker(loadConfig(), async (run) => {
          await run(registerWithRefund);
          await body(on, run);
        }),
      ),
    CHARGE_REFUND_ON,
  );
};

/** The signed serviceUrl callback of the 1 USD verify charge (Approved by default). */
const chargeCallback = async (
  http: Http,
  ref: string,
  over: Record<string, string> = {},
): Promise<void> => {
  const res = await postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: ref,
      amount: '1',
      currency: 'USD',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: '1100',
      recToken: 'tok_cr',
      createdDate: String(Math.floor(Date.now() / 1000)),
      ...over,
    }),
  );
  assert.equal(res.status, 200, `charge callback for ${ref} accepted`);
};

/** The poller's journal copy of an order, as the poller maps it. */
const pollerRow = (run: OnWorker, row: Record<string, string>) => {
  const charge = mapTransaction(row);
  assert.ok(charge !== null, 'the journal row maps to a charge');
  return run(
    Effect.flatMap(ChargePipeline, (pipeline) => pipeline.ingest(charge)),
  );
};

const refundTasks = (http: Http, ref: string) =>
  scalar(
    http,
    `SELECT count(*) FROM messages WHERE "messageType" = '${CARD_CHECK_REFUND}' AND "idemKey" = 'card_check_refund:${ref}'`,
  );

const refundState = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT coalesce("verifyRefundState", '') || '|' || ("verifyRefundedAt" IS NOT NULL) FROM checkout_sessions WHERE id = '${id}'`,
  );

const eventNames = (http: Http, contact: string) =>
  eventsOf(http, contact).then((e) => e.replace(/:[^,]+/g, ''));

const createId = async (http: Http, body: Json, what: string) =>
  sessionIdOf(await createSession(http, body), what);

// ---------------------------------------------------------------------------------
// create rules, echo, pay instruction
// ---------------------------------------------------------------------------------

const methodWithoutCardCheck = async (http: Http) => {
  const res = await createSession(
    http,
    chargeRefundBody('sp:cr-now', { firstCharge: 'now' }),
  );

  assert.equal(res.status, 400, 'cardCheckMethod without card_check → 400');
};

const chargeRefundFlagOff = async (http: Http) => {
  await withCardCheckApp(http, async (on) => {
    const res = await createSession(on, chargeRefundBody('sp:cr-off'));

    assert.equal(res.status, 422, 'charge_refund while its flag is off → 422');
    assert.equal(
      ((await res.json()) as Json)['code'],
      'card_check_disabled',
      'with the code an unadmitted card check carries',
    );
    const lookup = (await (
      await createSession(on, cardCheckBody('sp:cr-off-lookup'))
    ).json()) as Json;
    assert.equal(
      lookup['cardCheckMethod'],
      'lookup',
      'a card check without a method is a lookup, echoed',
    );
  });
};

const echoAndIdentity = async (http: Http): Promise<string> => {
  const fixed = { startsAt: new Date(Date.now() + 10 * DAY).toISOString() };
  const created = await createSession(
    http,
    chargeRefundBody('sp:cr-echo', fixed),
    'cr-key',
  );
  const body = (await created.clone().json()) as Json;
  const id = await sessionIdOf(created, 'charge_refund create');
  assert.deepEqual(
    [body['firstCharge'], body['cardCheckMethod']],
    ['card_check', 'charge_refund'],
    'the create echoes the method',
  );
  const otherMethod = await createSession(
    http,
    cardCheckBody('sp:cr-echo', fixed),
    'cr-key',
  );
  assert.equal(otherMethod.status, 409, 'the key cannot switch the method');
  const fullPrice = (await (
    await createSession(http, cardCheckBody('sp:cr-np', { firstCharge: 'now' }))
  ).json()) as Json;
  assert.equal(
    'cardCheckMethod' in fullPrice,
    false,
    'a full-price create carries no method',
  );
  return id;
};

const readAndPay = async (http: Http, id: string) => {
  const read = await publicRead(http, id);
  assert.deepEqual(
    [read['cardCheckMethod'], read['cardCheckChargeAmount']],
    ['charge_refund', 100],
    'the read echoes the method and the verify charge',
  );
  const paid = await pay(http, id, PaymentMethod.Card);
  assert.equal(paid.status, 200, '/pay → 200');
  const fields = paid.body['fields'] as Json;
  assert.deepEqual(
    [
      fields['orderReference'],
      fields['amount'],
      fields['currency'],
      fields['productName'],
      fields['paymentSystem'],
      fields['regularMode'],
    ],
    [id, 1, 'USD', [VERIFY_CHARGE_PRODUCT_NAME], undefined, undefined],
    'a 1 USD Purchase on the session order, not the verify form',
  );
};

const createScenario: Scenario = {
  name: 'card check charge_refund (HTTP): create rules, flag gate, echo + identity, the 1 USD Purchase form',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-create');
    await methodWithoutCardCheck(http);
    await chargeRefundFlagOff(http);
    await withCardCheckApp(
      http,
      async (on) => {
        const id = await echoAndIdentity(on);
        await readAndPay(on, id);
      },
      CHARGE_REFUND_ON,
    );
  },
};

// ---------------------------------------------------------------------------------
// activation, one refund for every copy, the provider's refund row swallowed
// ---------------------------------------------------------------------------------

const activateAndRefundOnce = async (
  http: Http,
  run: OnWorker,
  endpoint: Endpoint,
) => {
  const startsAt = new Date(Date.now() + 10 * DAY);
  const id = await createId(
    http,
    chargeRefundBody('sp:cr-ok', { startsAt: startsAt.toISOString() }),
    'create',
  );

  await chargeCallback(http, id);
  await pollerRow(run, {
    transactionType: 'PURCHASE',
    orderReference: id,
    createdDate: '1795000000',
    amount: '1',
    currency: 'USD',
    transactionStatus: 'Approved',
  });
  await run(drain);

  assert.equal(
    await scalar(
      http,
      `SELECT "recurringTokenRef" || '|' || (extract(epoch FROM "nextPaymentDate") * 1000)::bigint || '|' || amount || '|' || "firstCharge" FROM payments WHERE "externalUserId" = 'sp:cr-ok'`,
    ),
    `tok_cr|${String(startsAt.getTime())}|5000|card_check`,
    'activated on the charge token, the plan charged first at startsAt',
  );
  assert.equal(
    await eventNames(http, 'sp:cr-ok'),
    'payment_created,subscription_card_checked',
    'the verify charge is no payment event',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT (payload->>'amount') || '|' || (payload->>'cardCheckMethod') FROM domain_events WHERE name = 'subscription_card_checked' AND "externalUserId" = 'sp:cr-ok'`,
    ),
    '0|charge_refund',
    'subscription_card_checked reports amount 0 and the method',
  );
  assert.equal(
    await refundTasks(http, id),
    '1',
    'one refund task for two copies',
  );
  assert.deepEqual(
    endpoint
      .refunds(id)
      .map((b) => [b['amount'], b['currency'], b['comment'], b['apiVersion']]),
    [[1, 'USD', 'Card verification refund', 1]],
    'one REFUND of the 1 USD charge',
  );
  assert.equal(await refundState(http, id), 'refunded|true', 'refund recorded');
  return id;
};

const providerRefundSwallowed = async (
  http: Http,
  run: OnWorker,
  id: string,
) => {
  await chargeCallback(http, id, {
    transactionStatus: 'Refunded',
    reasonCode: '1100',
  });
  await pollerRow(run, {
    transactionType: 'REFUND',
    orderReference: id,
    createdDate: '1795000100',
    amount: '1',
    currency: 'USD',
    transactionStatus: 'Refunded',
  });
  await run(drain);

  assert.equal(
    await eventNames(http, 'sp:cr-ok'),
    'payment_created,subscription_card_checked',
    'no payment_refunded, no anomaly',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = '${id}'`,
    ),
    '0',
    'nothing quarantined',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(DISTINCT "matchResult", ',') FROM charges WHERE "externalRef" = '${id}'`,
    ),
    'matched',
    'every copy settled by the card-check step',
  );
};

const activationScenario: Scenario = {
  name: 'card check charge_refund: activation on the approved charge, one REFUND for callback + poller copies, the provider refund row swallowed',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-activate');
    const endpoint = await w4pEndpoint(() => 'refunded');
    try {
      await withChargeRefund(http, endpoint, async (on, run) => {
        const id = await activateAndRefundOnce(on, run, endpoint);
        await providerRefundSwallowed(on, run, id);
      });
    } finally {
      endpoint.server.close();
    }
  },
};

// ---------------------------------------------------------------------------------
// refund owed whatever the outcome
// ---------------------------------------------------------------------------------

const lateRefunded = async (http: Http, run: OnWorker, endpoint: Endpoint) => {
  const id = await createId(
    http,
    chargeRefundBody('sp:cr-late', {
      startsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    }),
    'create late',
  );

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(await paymentsOf(http, 'sp:cr-late'), '0', 'late: no payment');
  assert.equal(await eventNames(http, 'sp:cr-late'), 'card_check_failed');
  assert.equal(
    await scalar(
      http,
      `SELECT (payload->>'reason') || '|' || (payload->>'cardCheckMethod') FROM domain_events WHERE "externalUserId" = 'sp:cr-late'`,
    ),
    'late|charge_refund',
    'card_check_failed late reports the method',
  );
  assert.equal(endpoint.refunds(id).length, 1, 'late: refunded');
};

const closedRefunded = async (
  http: Http,
  run: OnWorker,
  endpoint: Endpoint,
) => {
  const id = await createId(http, chargeRefundBody('sp:cr-closed'), 'create');
  assert.equal((await close(http, id)).status, 200, 'closed first');

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(
    await paymentsOf(http, 'sp:cr-closed'),
    '0',
    'closed: no payment',
  );
  assert.equal(endpoint.refunds(id).length, 1, 'closed: refunded');
  assert.equal(await refundState(http, id), 'refunded|true');
};

const onLiveRefunded = async (
  http: Http,
  run: OnWorker,
  endpoint: Endpoint,
) => {
  await seedPayment({
    contact: 'sp:cr-live',
    next: new Date(Date.now() + 20 * DAY),
    firstCharge: 'now',
  });
  const id = await createId(http, chargeRefundBody('sp:cr-live'), 'create');

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(
    await statusAndReason(http, id).then((s) => s.split('|')[1]),
    'on_live',
    'closed on_live',
  );
  assert.equal(endpoint.refunds(id).length, 1, 'on_live: refunded');
};

const anomalousRefunded = async (
  http: Http,
  run: OnWorker,
  endpoint: Endpoint,
) => {
  const id = await createId(http, chargeRefundBody('sp:cr-odd'), 'create');

  await chargeCallback(http, id, { amount: '2' });
  await run(drain);

  assert.equal(await eventNames(http, 'sp:cr-odd'), 'card_check_anomaly');
  assert.deepEqual(
    endpoint.refunds(id).map((b) => b['amount']),
    [2],
    'anomalous: the amount actually charged is refunded',
  );
};

const declinedNotRefunded = async (
  http: Http,
  run: OnWorker,
  endpoint: Endpoint,
) => {
  const id = await createId(http, chargeRefundBody('sp:cr-decl'), 'create');

  await chargeCallback(http, id, {
    transactionStatus: 'Declined',
    reasonCode: '1101',
  });
  await run(drain);

  assert.equal(await eventNames(http, 'sp:cr-decl'), 'card_check_failed');
  assert.equal(await refundTasks(http, id), '0', 'a decline took nothing');
  assert.equal(endpoint.refunds(id).length, 0);
};

const outcomesScenario: Scenario = {
  name: 'card check charge_refund: the approved charge is refunded on late, closed, on_live and anomalous; a decline owes nothing',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-outcomes');
    const endpoint = await w4pEndpoint(() => 'refunded');
    try {
      await withChargeRefund(http, endpoint, async (on, run) => {
        await lateRefunded(on, run, endpoint);
        await closedRefunded(on, run, endpoint);
        await onLiveRefunded(on, run, endpoint);
        await anomalousRefunded(on, run, endpoint);
        await declinedNotRefunded(on, run, endpoint);
      });
    } finally {
      endpoint.server.close();
    }
  },
};

// ---------------------------------------------------------------------------------
// refund failure
// ---------------------------------------------------------------------------------

const refundFailedEvent = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT "aggregateId" || '|' || (payload->>'orderReference') || '|' || (payload->>'amount') || '|' || (payload->>'currency') || '|' || coalesce(payload->>'reasonCode', 'null') FROM domain_events WHERE name = 'card_check_refund_failed' AND "externalUserId" = '${contact}'`,
  );

const declinedRefund = async (http: Http, run: OnWorker) => {
  const id = await createId(http, chargeRefundBody('sp:cr-refused'), 'create');

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(
    await refundFailedEvent(http, 'sp:cr-refused'),
    `${id}|${id}|100|1|1112`,
    'a refused refund reports at once, with the provider code',
  );
  assert.equal(await refundState(http, id), 'failed|false');
};

const spentBudgetReports = async (http: Http, run: OnWorker, wfp: Endpoint) => {
  const id = await createId(http, chargeRefundBody('sp:cr-down'), 'create');
  // Arrange a spent budget: every REFUND attempt already ended without an answer.
  await run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`UPDATE checkout_sessions SET "verifyRefundAttempts" = ${CARD_CHECK_REFUND_MAX_ATTEMPTS} WHERE id = ${id}`,
    ),
  );

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(wfp.refunds(id).length, 0, 'no REFUND past the budget');
  assert.equal(
    await refundFailedEvent(http, 'sp:cr-down'),
    `${id}|${id}|100|1|null`,
    'the order still holds the money: reported, with no provider code',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT status FROM messages WHERE "idemKey" = 'card_check_refund:${id}'`,
    ),
    'success',
    'the task ends handled, not dead-lettered',
  );
};

const retriedRefund = async (http: Http, run: OnWorker) => {
  const id = await createId(http, chargeRefundBody('sp:cr-blip'), 'create');

  await chargeCallback(http, id);
  await run(drain);

  assert.equal(
    await scalar(
      http,
      `SELECT status || '|' || (SELECT "verifyRefundState" FROM checkout_sessions WHERE id = '${id}') FROM messages WHERE "idemKey" = 'card_check_refund:${id}'`,
    ),
    'retry|pending',
    'a transport failure with budget left retries, nothing reported',
  );
  assert.equal(await refundFailedEvent(http, 'sp:cr-blip'), '');
};

const failureScenario: Scenario = {
  name: 'card check charge_refund: a refused refund and an exhausted retry budget emit card_check_refund_failed once; a blip retries',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-failure');
    // What the provider answers next; each step sets it before its charge lands.
    let reply: RefundReply = 'declined';
    const endpoint = await w4pEndpoint(() => reply);
    try {
      await withChargeRefund(http, endpoint, async (on, run) => {
        await declinedRefund(on, run);
        reply = 'garbage';
        await spentBudgetReports(on, run, endpoint);
        await retriedRefund(on, run);
      });
    } finally {
      endpoint.server.close();
    }
  },
};

// ---------------------------------------------------------------------------------
// one REFUND owner at a time, takeover after the lease, the report past the budget
// ---------------------------------------------------------------------------------

/** A session whose refund stands as `refund` says, and its task on the queue. */
const owedRefund = async (
  http: Http,
  run: OnWorker,
  seed: { readonly contact: string; readonly refund: string },
): Promise<string> => {
  const id = await createId(http, chargeRefundBody(seed.contact), 'create');
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        `UPDATE checkout_sessions SET ${seed.refund} WHERE id = '${id}'`,
      );
      yield* enqueue(sql)({
        messageType: CARD_CHECK_REFUND,
        idemKey: `card_check_refund:${id}`,
        payload: {
          checkoutSessionId: id,
          orderReference: id,
          amount: 100,
          currency: 1,
        },
      });
    }),
  );
  return id;
};

const liveClaimWaits = async (http: Http, run: OnWorker, wfp: Endpoint) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-owned',
    refund: `"verifyRefundState" = 'in_flight', "verifyRefundClaimedAt" = now(), "verifyRefundAttempts" = 1`,
  });

  await run(drain);

  assert.equal(wfp.calls(id), 0, 'a live claim: no provider call');
  assert.equal(
    await scalar(
      http,
      `SELECT m.status || '|' || c."verifyRefundState" || '|' || c."verifyRefundAttempts" FROM messages m JOIN checkout_sessions c ON c.id = '${id}' WHERE m."idemKey" = 'card_check_refund:${id}'`,
    ),
    'retry|in_flight|1',
    'the redelivery waits for the owner and spends nothing',
  );
};

const staleClaimReconciled = async (
  http: Http,
  run: OnWorker,
  wfp: Endpoint,
) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-stale',
    refund: `"verifyRefundState" = 'in_flight', "verifyRefundClaimedAt" = now() - interval '1 hour', "verifyRefundAttempts" = 1`,
  });

  await run(drain);

  assert.equal(wfp.refunds(id).length, 0, 'no second REFUND');
  assert.equal(wfp.calls(id), 1, 'one CHECK_STATUS');
  assert.equal(
    await refundState(http, id),
    'refunded|true',
    'the dead owner refunded: taken over and settled from the order status',
  );
};

const spentBudgetSettles = async (http: Http, run: OnWorker, wfp: Endpoint) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-spent',
    refund: `"verifyRefundState" = 'in_flight', "verifyRefundClaimedAt" = now() - interval '1 hour', "verifyRefundAttempts" = ${String(CARD_CHECK_REFUND_MAX_ATTEMPTS)}`,
  });

  await run(drain);

  assert.equal(wfp.refunds(id).length, 0, 'no REFUND past the budget');
  assert.equal(
    await refundState(http, id),
    'refunded|true',
    'the last REFUND went through before its worker died: settled, not reported',
  );
  assert.equal(await refundFailedEvent(http, 'sp:cr-spent'), '');
};

const deadLetterRevived = async (http: Http, run: OnWorker, wfp: Endpoint) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-dead',
    refund: `"verifyRefundState" = 'pending'`,
  });
  // Arrange the queue giving up first (a database outage): the task is dead-lettered.
  await run(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`UPDATE messages SET status = 'fail', "finishedAt" = now() WHERE "idemKey" = ${`card_check_refund:${id}`}`,
    ),
  );

  const revived = await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sweepOwedRefunds(sql)),
  );
  await run(drain);

  assert.equal(revived, 1, 'the sweep revives the owed refund');
  assert.equal(wfp.refunds(id).length, 1, 'and it goes out');
  assert.equal(await refundState(http, id), 'refunded|true');
};

const ownershipScenario: Scenario = {
  name: 'card check charge_refund: a live REFUND claim makes a redelivery wait; a stale one is taken over by status; a spent budget only asks; a dead-lettered refund is revived',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-owner');
    let orderStatus = 'Refunded';
    const endpoint = await w4pEndpoint(
      () => 'refunded',
      () => orderStatus,
    );
    try {
      await withChargeRefund(http, endpoint, async (on, run) => {
        await liveClaimWaits(on, run, endpoint);
        await staleClaimReconciled(on, run, endpoint);
        await spentBudgetSettles(on, run, endpoint);
        orderStatus = 'Approved';
        await deadLetterRevived(on, run, endpoint);
      });
    } finally {
      endpoint.server.close();
    }
  },
};

// ---------------------------------------------------------------------------------
// a locked row is skipped, not waited for; reconciliation is bounded
// ---------------------------------------------------------------------------------

const taskOf = (id: string) => ({
  checkoutSessionId: id,
  orderReference: id,
  amount: 100,
  currency: 1,
});

/** The refund handler as the worker builds it, on the worker's WayForPay client. */
const refundHandler = Effect.gen(function* () {
  return cardCheckRefundHandler({
    sql: yield* SqlClient.SqlClient,
    client: yield* WayForPay,
    publish: (yield* Outbox).publish,
  });
});

/** Two deliveries of the task at once; how each ended. */
const twoDeliveries = (id: string) =>
  Effect.gen(function* () {
    const handle = yield* refundHandler;
    const outcomes = yield* Effect.all(
      [handle(taskOf(id)), handle(taskOf(id))].map((delivery) =>
        Effect.either(delivery),
      ),
      { concurrency: 'unbounded' },
    );
    return outcomes.map((o) => (o._tag === 'Left' ? o.left._tag : 'done'));
  });

/**
 * Hold the session row (as a settlement transaction would) while two deliveries run,
 * then let it go and run two more. The ones under the lock must not wait for it.
 */
const lockedThenOverlapping = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locked = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const holder = yield* Effect.fork(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT id FROM checkout_sessions WHERE id = ${id} FOR UPDATE`;
          yield* Deferred.succeed(locked, true);
          yield* Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(locked);
    const underLock = yield* twoDeliveries(id).pipe(
      Effect.timeoutFail({
        duration: '10 seconds',
        onTimeout: () => new Error('a claim waited on the locked row'),
      }),
    );
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(holder);
    const after = yield* twoDeliveries(id);
    return { underLock, after };
  });

const oneOwner = async (http: Http, run: OnWorker, wfp: Endpoint) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-race',
    refund: `"verifyRefundState" = 'pending'`,
  });

  const { underLock, after } = await run(lockedThenOverlapping(id));

  assert.deepEqual(
    underLock,
    ['RefundClaimed', 'RefundClaimed'],
    'under the row lock both deliveries step aside at once, owed and waiting',
  );
  assert.ok(after.includes('done'), 'after it, one delivery refunds');
  assert.equal(wfp.refunds(id).length, 1, 'exactly one REFUND');
  assert.equal(
    await scalar(
      http,
      `SELECT "verifyRefundAttempts" || '|' || "verifyRefundState" FROM checkout_sessions WHERE id = '${id}'`,
    ),
    '1|refunded',
    'exactly one claim',
  );
};

/** One delivery of the task; how it ended. */
const oneDelivery = (id: string) =>
  Effect.flatMap(refundHandler, (handle) =>
    Effect.either(handle(taskOf(id))).pipe(
      Effect.map((o) => (o._tag === 'Left' ? o.left._tag : 'done')),
    ),
  );

const statusOutagePastBudget = async (
  http: Http,
  run: OnWorker,
  wfp: Endpoint,
) => {
  const id = await owedRefund(http, run, {
    contact: 'sp:cr-dark',
    refund: `"verifyRefundState" = 'pending', "verifyRefundAttempts" = ${String(CARD_CHECK_REFUND_MAX_ATTEMPTS)}`,
  });

  // Every status-only claim the budget allows, and two more after it.
  const outcomes = await run(
    Effect.forEach(
      Array.from({ length: CARD_CHECK_REFUND_RECONCILE_ATTEMPTS + 2 }),
      () => oneDelivery(id),
    ),
  );

  assert.deepEqual(
    outcomes,
    [
      ...Array.from<string>({
        length: CARD_CHECK_REFUND_RECONCILE_ATTEMPTS - 1,
      }).fill('RefundRetry'),
      'done',
      'done',
      'done',
    ],
    'status-only claims retry until the last, which reports; later ones find it failed',
  );
  assert.equal(wfp.refunds(id).length, 0, 'no REFUND past the REFUND budget');
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) || '|' || string_agg((payload->>'outcomeUncertain') || '|' || coalesce(payload->>'reasonCode', 'null'), ',') FROM domain_events WHERE name = 'card_check_refund_failed' AND "externalUserId" = 'sp:cr-dark'`,
    ),
    '1|true|null',
    'exactly one failure event, marked uncertain',
  );
  assert.equal(await refundState(http, id), 'failed|false');
};

const lateProviderRefundSettles = async (
  http: Http,
  run: OnWorker,
  id: string,
) => {
  await chargeCallback(http, id, {
    transactionStatus: 'Refunded',
    reasonCode: '1100',
  });
  await run(drain);

  assert.equal(
    await refundState(http, id),
    'refunded|true',
    'a later provider Refunded row still settles it',
  );
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM domain_events WHERE name = 'card_check_refund_failed' AND "externalUserId" = 'sp:cr-dark'`,
    ),
    '1',
    'and publishes nothing more',
  );
};

const boundsScenario: Scenario = {
  name: 'card check charge_refund: a locked row is skipped, not waited for, and one delivery owns the REFUND; a status outage past the budget reports once, uncertain',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cr-bounds');
    let orderStatus = 'Approved';
    const endpoint = await w4pEndpoint(
      () => 'refunded',
      () => orderStatus,
    );
    try {
      await withChargeRefund(http, endpoint, async (on, run) => {
        await oneOwner(on, run, endpoint);
        orderStatus = 'garbage';
        await statusOutagePastBudget(on, run, endpoint);
        const id = await scalar(
          on,
          `SELECT id FROM checkout_sessions WHERE "externalUserId" = 'sp:cr-dark'`,
        );
        await lateProviderRefundSettles(on, run, id);
      });
    } finally {
      endpoint.server.close();
    }
  },
};

export const cardCheckChargeScenarios: readonly Scenario[] = [
  createScenario,
  activationScenario,
  outcomesScenario,
  failureScenario,
  ownershipScenario,
  boundsScenario,
];
