import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DomainEvent } from '@billing-service/shared';
import { Effect } from 'effect';

import type { AppConfig } from '@/config.js';
import {
  drain,
  type EffectE2eContext,
  type EffectScenario,
  expectRows,
  registerHandlers,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';

/**
 * The CRM sink through the real worker: publish → fan-out → `deliver_event` → the CRM
 * connector → a local CRM stub over real HTTP → the queue's verdict. What only shows here
 * is the dispatcher reading a failure as permanent and dead-lettering it on the first
 * attempt, with the event still delivered to the other sink.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface CrmStub {
  readonly url: string;
  /** How many POSTs reached the stub. */
  readonly posts: () => number;
  readonly close: () => Promise<void>;
}

const startCrmStub = async (handler: Handler): Promise<CrmStub> => {
  let posts = 0;
  const server = createServer((req, res) => {
    posts += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port.toString()}/api/public/v1/events`,
    posts: () => posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** The CRM door's 200 for an event it stored with this `schema_status`. */
const answering =
  (schemaStatus: string): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        event_id: 'crm_evt_1',
        schema_status: schemaStatus,
      }),
    );
  };

const enableCrmSink = (query: EffectE2eContext['query'], url: string) =>
  query(
    `UPDATE sinks SET enabled = true, config = '{"url":"${url}"}'::jsonb, auth = '{"kind":0,"token":"e2e-crm-token"}'::jsonb WHERE kind = 1`,
  );

/** No config cache: a sink disabled mid-scenario is seen by the very next delivery. */
const uncached = (config: AppConfig): AppConfig => ({
  ...config,
  sinks: { ...config.sinks, cacheTtlMillis: 0 },
});

const succeeded: DomainEvent = {
  id: 'evt_e2e_crm:succeeded',
  idempotencyKey: 'evt_e2e_crm:succeeded',
  name: 'recurring_payment_succeeded',
  occurredAt: new Date('2026-03-01T10:00:00Z'),
  correlationId: 'e2e-crm',
  externalUserId: 'sp:crm-e2e',
  aggregateId: 'pay_e2e_crm',
  payload: {
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    source: 'wayforpay_charge',
    nextPaymentDate: '2026-04-01T00:00:00.000Z',
    periodStart: '2026-03-01T00:00:00.000Z',
    periodEnd: '2026-04-01T00:00:00.000Z',
    recurring: true,
    metadata: null,
  },
};

const publishSucceeded = Effect.gen(function* () {
  yield* registerHandlers;
  yield* (yield* Outbox).publish(succeeded);
});

/** status | attemptCount of the `deliver_event` message for one sink. */
const deliveryMessageSql = (sink: string) =>
  `SELECT m.status || '|' || m."attemptCount" FROM messages m JOIN event_deliveries d ON d.id::text = m.payload->>'deliveryId' WHERE d.sink = '${sink}'`;

const deliveryStatusSql = (sink: string) =>
  `SELECT status FROM event_deliveries WHERE sink = '${sink}'`;

const rejectedMoneyEventDeadLetters: EffectScenario = {
  name: 'crm sink: a success event the CRM stores as rejected dead-letters on its first attempt; SendPulse still gets it',
  run: async ({ config, query }) => {
    const crm = await startCrmStub(answering('rejected'));
    try {
      await enableCrmSink(query, crm.url);
      await withWorker(config, async (run) => {
        await run(publishSucceeded);
        await run(drain);
      });

      await expectRows(query, [
        [deliveryMessageSql('crm'), 'fail|1', 'dead-lettered, one attempt'],
        [deliveryStatusSql('crm'), 'failed', 'the CRM delivery is failed'],
        [
          `SELECT error->>'message' FROM attempts a JOIN messages m ON m.id = a."messageId" JOIN event_deliveries d ON d.id::text = m.payload->>'deliveryId' WHERE d.sink = 'crm'`,
          'crm: crm stored recurring_payment_succeeded as rejected (event crm_evt_1)',
          'the attempt says why',
        ],
        [
          deliveryStatusSql('sendpulse'),
          'delivered',
          'the other sink is unaffected',
        ],
      ]);
      assert.equal(crm.posts(), 1, 'posted once, never re-sent');
    } finally {
      await crm.close();
    }
  },
};

const validatedMoneyEventDelivers: EffectScenario = {
  name: 'crm sink: a success event the CRM stores as validated is delivered',
  run: async ({ config, query }) => {
    const crm = await startCrmStub(answering('validated'));
    try {
      await enableCrmSink(query, crm.url);
      await withWorker(config, async (run) => {
        await run(publishSucceeded);
        await run(drain);
      });

      await expectRows(query, [
        [deliveryMessageSql('crm'), 'success|1', 'one attempt, success'],
        [deliveryStatusSql('crm'), 'delivered', 'the CRM delivery is done'],
      ]);
    } finally {
      await crm.close();
    }
  },
};

const disabledSinkDeadLetters: EffectScenario = {
  name: 'crm sink: a delivery whose sink was disabled after fan-out dead-letters on its first attempt, nothing posted',
  run: async ({ config, query }) => {
    const crm = await startCrmStub(answering('validated'));
    try {
      await enableCrmSink(query, crm.url);
      await withWorker(uncached(config), async (run) => {
        await run(publishSucceeded);
        await query(`UPDATE sinks SET enabled = false WHERE kind = 1`);
        await run(drain);
      });

      await expectRows(query, [
        [deliveryMessageSql('crm'), 'fail|1', 'dead-lettered, one attempt'],
        [deliveryStatusSql('crm'), 'failed', 'the CRM delivery is failed'],
        [
          `SELECT count(*) FROM event_deliveries WHERE sink = 'crm' AND "lastError"->>'message' = 'no enabled sink named crm'`,
          '1',
          'the delivery row says why',
        ],
      ]);
      assert.equal(crm.posts(), 0, 'nothing posted to a disabled sink');
    } finally {
      await crm.close();
    }
  },
};

export const crmSinkScenarios: readonly EffectScenario[] = [
  rejectedMoneyEventDeadLetters,
  validatedMoneyEventDelivers,
  disabledSinkDeadLetters,
];
