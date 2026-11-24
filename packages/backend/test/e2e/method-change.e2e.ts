import assert from 'node:assert/strict';

import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  PAYMENT_METHOD_CHANGE,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

import { TaskRegistry } from '@/infra/task-registry.js';
import { registerHandlers, runFor } from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { methodChangeNotify } from '@/modules/payment/cancel.js';

import { bearer, withCardCheckApp } from './card-check.e2e.js';
import type { Scenario } from './http-harness.js';
import { postJson } from './http-harness.js';
import {
  eventsOf,
  type Http,
  httpContext,
  type Json,
  pay,
  publicRead,
  scalar,
  seedSubs,
  WHITEPAY_PAY_URL,
  withWhitePayApp,
  onApp,
  onDb,
} from './prolong.e2e.js';

/**
 * HTTP e2e for the method-less `/api/payment/method-change` (docs/32 §7): the bot sends
 * only the contact, the payer picks card or crypto on the hosted page. Crypto on an
 * up-to-date sub flips with no payment; card runs the verify; an owed link stays a
 * purchase of the arrears in either method.
 */

const END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
const DUE = new Date(Date.now() - 60 * 60 * 1000);
const ARREARS = 30000;
const VERIFY_ON = { W4P_CARD_VERIFY_ENABLED: 'true' };

/** A worker pass with the `payment_method_change` handler too, wired as worker-boot does
 * (the shared harness registers only the handlers its scenarios enqueue). */
const drainQueue = () =>
  onDb(
    Effect.gen(function* () {
      yield* registerHandlers;
      const registry = yield* TaskRegistry;
      const outbox = yield* Outbox;
      yield* registry.register(
        PAYMENT_METHOD_CHANGE,
        methodChangeNotify(outbox.publish),
      );
      yield* runFor(2);
    }),
  );

const methodChange = async (http: Http, contact: string): Promise<Json> => {
  const res = await postJson(
    `${http.baseUrl}/api/payment/method-change`,
    { externalUserId: contact },
    bearer(http.secret),
  );
  assert.equal(res.status, 200, `method change ${contact} → 200`);
  return (await res.json()) as Json;
};

const paymentOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT method || '|' || coalesce("recurringTokenRef", 'null') FROM payments WHERE "externalUserId" = '${contact}'`,
  );

const sessionOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT status || '|' || coalesce(method::text, 'null') || '|' || origin FROM checkout_sessions WHERE id = '${id}'`,
  );

const methodChangeMessages = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT count(*) FROM messages WHERE "messageType" = '${PAYMENT_METHOD_CHANGE}' AND payload->>'externalUserId' = '${contact}'`,
  );

/** Two racing Crypto presses on a method-less link: one flips, one loses the claim. */
const assertDoubleClickFlipsOnce = async (
  on: Http,
  contact: string,
  id: string,
): Promise<void> => {
  // A double click: both presses race; exactly one flips.
  const presses = await Promise.all([
    pay(on, id, PaymentMethod.Crypto),
    pay(on, id, PaymentMethod.Crypto),
  ]);
  const statuses = presses.map((p) => p.status).sort();
  await drainQueue();

  assert.deepEqual(statuses, [200, 409], 'one press wins, one loses');
  assert.deepEqual(
    presses.find((p) => p.status === 200)?.body,
    { kind: 'applied', method: PaymentMethod.Crypto },
    'the page is told the change is applied',
  );
  assert.equal(
    await paymentOf(on, contact),
    `${String(PaymentMethod.Crypto)}|null`,
    'crypto, token dropped',
  );
  assert.equal(
    await sessionOf(on, id),
    `${String(CheckoutSessionStatus.Completed)}|${String(PaymentMethod.Crypto)}|card_change`,
    'the link is used up',
  );
  assert.equal(
    await methodChangeMessages(on, contact),
    '1',
    'one method_changed message',
  );
  assert.equal(
    (await eventsOf(on, contact)).replace(/:[^,]+/g, ''),
    'method_changed',
    'method_changed only, no charge event',
  );
};

const cryptoPick: Scenario = {
  name: 'method change without a method: crypto picked on the page flips an up-to-date card sub once, with no payment',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'mc-crypto');
    const contact = 'sp:mc-crypto';
    await seedSubs([{ externalUserId: contact, end: END }]);
    await withCardCheckApp(
      http,
      async (on) => {
        const link = await methodChange(on, contact);
        assert.equal(link['kind'], 'checkout', 'always a link');
        const id = String(link['sessionId']);
        const read = await publicRead(on, id);
        assert.equal(read['method'], null, 'no method preselected');
        assert.equal(read['amount'], 0, 'priced as the card verify');
        assert.equal(read['kind'], CheckoutSessionKind.CardChange);

        await assertDoubleClickFlipsOnce(on, contact, id);
        assert.equal(
          (await pay(on, id, PaymentMethod.Card)).status,
          409,
          'a used link cannot pay again',
        );
      },
      VERIFY_ON,
    );
  },
};

const cardPick: Scenario = {
  name: 'method change without a method: card picked on the page hands out the verify form and changes nothing yet',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'mc-card');
    const contact = 'sp:mc-card';
    await seedSubs([{ externalUserId: contact, end: END }]);
    await withCardCheckApp(
      http,
      async (on) => {
        const id = String((await methodChange(on, contact))['sessionId']);

        const paid = await pay(on, id, PaymentMethod.Card);

        assert.equal(paid.status, 200, 'card pick → 200');
        assert.equal(paid.body['kind'], 'form');
        assert.equal(
          (paid.body['fields'] as Json)['paymentSystem'],
          'lookupCard',
          'the verify form',
        );
        assert.equal(
          await paymentOf(on, contact),
          `${String(PaymentMethod.Card)}|tok_old`,
          'the sub is untouched until the verify lands',
        );
        assert.equal(await methodChangeMessages(on, contact), '0');
      },
      VERIFY_ON,
    );
  },
};

const owedCryptoPick: Scenario = {
  name: 'method change without a method: an owed sub gets an arrears link, and crypto picked there is a crypto purchase, not a flip',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'mc-owed');
    const contact = 'sp:mc-owed';
    await seedSubs([
      { externalUserId: contact, end: END, status: PaymentStatus.PastDue },
    ]);
    await withWhitePayApp(async (whitePayUrl) => {
      const on = await onApp(http, whitePayUrl);
      const id = String((await methodChange(on, contact))['sessionId']);
      const read = await publicRead(on, id);

      const paid = await pay(on, id, PaymentMethod.Crypto);

      assert.equal(read['amount'], ARREARS, 'the arrears');
      assert.equal(read['method'], null, 'no method preselected');
      assert.deepEqual(
        paid.body,
        { kind: 'redirect', url: `${WHITEPAY_PAY_URL}/${id}` },
        'a WhitePay order for the arrears',
      );
      assert.equal(
        await sessionOf(on, id),
        `${String(CheckoutSessionStatus.Pending)}|${String(PaymentMethod.Crypto)}|card_change_arrears`,
      );
      assert.equal(
        await paymentOf(on, contact),
        `${String(PaymentMethod.Card)}|tok_old`,
        'nothing flips before the crypto payment lands',
      );
    });
  },
};

const explicitCrypto = (http: Http, contact: string) =>
  postJson(
    `${http.baseUrl}/api/payment/method-change`,
    { externalUserId: contact, method: PaymentMethod.Crypto },
    bearer(http.secret),
  );

const dueSub: Scenario = {
  name: 'method change: an Active sub already due (the scheduler may be charging it) never flips — 409 on the page pick and on method 1, token untouched',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'mc-due');
    const contact = 'sp:mc-due';
    await seedSubs([
      { externalUserId: contact, end: END, nextPaymentDate: DUE },
    ]);
    const id = String((await methodChange(http, contact))['sessionId']);

    const picked = await pay(http, id, PaymentMethod.Crypto);
    const explicit = await explicitCrypto(http, contact);

    assert.equal(picked.status, 409, 'page pick → 409');
    assert.equal(explicit.status, 409, 'method 1 → 409');
    assert.equal(
      await paymentOf(http, contact),
      `${String(PaymentMethod.Card)}|tok_old`,
      'still card, token untouched',
    );
    assert.equal(
      await sessionOf(http, id),
      `${String(CheckoutSessionStatus.Created)}|null|card_change`,
      'the claim rolled back',
    );
    assert.equal(await methodChangeMessages(http, contact), '0');
  },
};

/** Put the sub back on a card, as a settled card verify would (fixture shortcut). */
const backOnCard = (paymentId: string) =>
  onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) => {
      const payments = makePaymentRepo(sql);
      return Effect.zipRight(
        payments.updateToken(paymentId, 'tok_new'),
        payments.setMethod(paymentId, PaymentMethod.Card),
      );
    }),
  );

const switchTwice: Scenario = {
  name: 'method change: crypto → card → crypto through separate links in one period announces both crypto switches',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'mc-twice');
    const contact = 'sp:mc-twice';
    const sub = (await seedSubs([{ externalUserId: contact, end: END }]))(
      contact,
    );
    const first = String((await methodChange(http, contact))['sessionId']);
    assert.equal((await pay(http, first, PaymentMethod.Crypto)).status, 200);
    await backOnCard(sub.id);
    const second = String((await methodChange(http, contact))['sessionId']);

    const again = await pay(http, second, PaymentMethod.Crypto);

    assert.equal(again.status, 200, 'second switch applied');
    assert.equal(
      await paymentOf(http, contact),
      `${String(PaymentMethod.Crypto)}|null`,
    );
    assert.equal(
      await methodChangeMessages(http, contact),
      '2',
      'one message per switch',
    );
  },
};

export const methodChangeScenarios: readonly Scenario[] = [
  cryptoPick,
  cardPick,
  owedCryptoPick,
  dueSub,
  switchTwice,
];
