import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SqlClient } from '@effect/sql';
import { CheckoutSessionKind } from '@billing-service/shared';
import { Effect, Logger } from 'effect';

import { enqueue } from '@/infra/queue/store.js';
import { PAYMENT_REBIND } from '@/modules/charge/contracts.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  asPayload,
  type Check,
  drain,
  type EffectScenario,
  expectRows,
  registerHandlers,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { pollTick } from '@/modules/wayforpay/poller.js';

/**
 * Refunds through the real queue and database (docs/34): a WayForPay refund of a settled
 * order becomes one `payment_refunded`, whichever copies of it arrive, and a refund is
 * never bound as a payment.
 */

const BUYER = '64b7f0c2a1d3e4f5a6b7c8d9';

const seedSession = (id: string, externalUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* makeCheckoutRepo(sql).insert({
      id,
      externalUserId,
      amount: 30000,
      currency: 0,
      period: 'P1M',
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
      metadata: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
  });

const approved = (orderReference: string) =>
  normalizeCallback({
    orderReference,
    amount: '300',
    currency: 'UAH',
    transactionStatus: 'Approved',
    recToken: 'tok_refund',
    createdDate: '1788000000',
  });

const refunded = (orderReference: string, amount = '300') =>
  normalizeCallback({
    orderReference,
    amount,
    currency: 'UAH',
    transactionStatus: 'Refunded',
    reason: 'Refunded by merchant',
    createdDate: '1788600000',
  });

const ingestAll = (charges: readonly ReturnType<typeof normalizeCallback>[]) =>
  Effect.gen(function* () {
    const pipeline = yield* ChargePipeline;
    yield* Effect.forEach(charges, (c) => pipeline.ingest(c), {
      discard: true,
    });
    yield* drain;
  });

const approveThenRefund = (orderReference: string) =>
  Effect.gen(function* () {
    yield* registerHandlers;
    yield* seedSession(orderReference, BUYER);
    yield* ingestAll([approved(orderReference)]);
    yield* ingestAll([refunded(orderReference)]);
  });

const countOf = (name: string) =>
  `SELECT count(*) FROM domain_events WHERE name = '${name}'`;

const oneRefundOf = (orderReference: string): readonly Check[] => [
  [countOf('payment_refunded'), '1', 'one payment_refunded for the order'],
  [
    `SELECT id || ' ' || "externalUserId" || ' ' || ("aggregateId" = (SELECT id::text FROM payments WHERE "externalUserId" = '${BUYER}')) FROM domain_events WHERE name = 'payment_refunded'`,
    `evt_refund:${orderReference} ${BUYER} true`,
    'filed under the order, the buyer and the payment the success created',
  ],
  [
    `SELECT payload->>'originalEventId' || ' ' || (payload->>'amount') || ' ' || (payload->>'orderReference') FROM domain_events WHERE name = 'payment_refunded'`,
    `evt_w4pcb:${orderReference}|Approved:succeeded 30000 ${orderReference}`,
    'names the reversed success event, the refunded amount and the order',
  ],
];

const reportOf = (counts: Partial<Record<string, number>>) => ({
  selected: 0,
  unresolved: 0,
  skipped: 0,
  emitted: 0,
  duplicate: 0,
  failed: 0,
  ...counts,
});

/** Three refunds quarantined before their originals settled (the pre-docs/34 state):
 * one of a buyer's order, one of a smoke-test order, one of an order billing never saw. */
const quarantinedBeforeOriginals = Effect.gen(function* () {
  yield* registerHandlers;
  yield* ingestAll([
    refunded('chk_backfill'),
    refunded('chk_smoke'),
    refunded('chk_unknown'),
  ]);
  yield* seedSession('chk_backfill', BUYER);
  yield* seedSession('chk_smoke', 'smoke-1784463928');
  yield* ingestAll([approved('chk_backfill'), approved('chk_smoke')]);
});

const BACKEND_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const COMMAND = 'charges:reprocess-refunded';

/** Run the operator command as production does: the worker entrypoint with the command
 * argument, its own process, against the scenario database (`setAppEnv` put it in env). */
const runCommand = () => {
  const result = spawnSync('npx', ['tsx', 'src/worker.ts', COMMAND], {
    cwd: BACKEND_DIR,
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = result.stdout
    .split('\n')
    .find((l) => l.startsWith(`${COMMAND} {`));
  assert.equal(result.status, 0, `${COMMAND} exits 0: ${result.stderr}`);
  assert.ok(line, `${COMMAND} prints its counters`);
  return {
    line,
    report: JSON.parse(line.slice(COMMAND.length + 1)) as unknown,
  };
};

/**
 * A bind queued while the refund sat in quarantine, dispatched only after the refund was
 * attributed: the worker still refuses it. The route refuses such a bind today; this is
 * the message enqueued before that guard, or before the refund was resolved.
 */
const staleBindAfterResolution = Effect.gen(function* () {
  yield* registerHandlers;
  yield* ingestAll([refunded('chk_stale')]);
  const sql = yield* SqlClient.SqlClient;
  const [record] = yield* makeChargeRepo(sql).listOpenQuarantine();
  assert.ok(record, 'the refund is in the quarantine queue');
  yield* enqueue(sql)({
    messageType: PAYMENT_REBIND,
    idemKey: `rebind:${record.quarantineId}`,
    payload: {
      incomingEventId: record.incomingEventId,
      quarantineId: record.quarantineId,
      externalUserId: BUYER,
      subscriptionId: null,
      period: 'P1M',
      method: 0,
    },
  });
  // The original settles and the refund is attributed while the bind waits in the queue.
  yield* seedSession('chk_stale', BUYER);
  yield* (yield* settlementHandler())(asPayload(approved('chk_stale')));
  const report = yield* (yield* ChargePipeline).reprocessRefunded();
  assert.deepEqual(report, reportOf({ selected: 1, emitted: 1 }));
  yield* drain;
});

/** A refund whose quarantine cannot be resolved: a trigger fails the resolve, which
 * runs after `payment_refunded` was published inside the same transaction. */
const FAIL_RESOLVE = `
  CREATE FUNCTION fail_resolve() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'injected: resolve fails'; END $$;
  CREATE TRIGGER fail_resolve BEFORE UPDATE ON quarantine_records
    FOR EACH ROW WHEN (NEW.status = 'resolved') EXECUTE FUNCTION fail_resolve();
`;

/** Run `effect` with every log message it (and the fibers it forks) writes collected. */
const capturingLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const messages: string[] = [];
  const capture = Logger.make(({ message }) => {
    messages.push(
      (Array.isArray(message) ? message : [message]).map(String).join(' '),
    );
  });
  return {
    messages,
    effect: effect.pipe(Effect.provide(Logger.add(capture))),
  };
};

const reprocess = Effect.flatMap(ChargePipeline, (p) => p.reprocessRefunded());

const pollRefund = (orderReference: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* pollTick(
      {
        client: {
          transactionList: () =>
            Effect.succeed([
              {
                transactionType: 'REFUND',
                orderReference,
                createdDate: '1788600000',
                amount: '300',
                currency: 'UAH',
                transactionStatus: 'Refunded',
              },
            ]),
        },
        ingest: (yield* ChargePipeline).ingest,
        state: makePollerStateRepo(sql),
      },
      {
        account: 'acc',
        pollIntervalSeconds: 120,
        windowOverlapSeconds: 900,
        maxWindowSeconds: 21600,
      },
    );
    yield* drain;
  });

export const refundScenarios: readonly EffectScenario[] = [
  {
    name: 'refund: Approved then Refunded callbacks emit one event of each name',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(approveThenRefund('chk_r1'));

        await expectRows(query, [
          [countOf('initial_payment_succeeded'), '1', 'one success'],
          [countOf('unknown_payment_quarantined'), '0', 'nothing quarantined'],
          ...oneRefundOf('chk_r1'),
          [
            `SELECT string_agg(status || ':' || "matchResult", ',' ORDER BY status) FROM charges`,
            'refunded:matched,succeeded:matched',
            'both charges stored and closed',
          ],
        ]);
      }),
  },
  {
    name: "refund: the poller's copy of a refunded callback adds no second event",
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(approveThenRefund('chk_r2'));

        await run(pollRefund('chk_r2'));

        await expectRows(query, [
          [
            `SELECT count(*) FROM charges WHERE status = 'refunded' AND "matchResult" = 'matched'`,
            '2',
            'callback and poller copies both stored and closed',
          ],
          ...oneRefundOf('chk_r2'),
        ]);
      }),
  },
  {
    // docs/34 D4: one refund per order. The callback key is order + status, so a second
    // refund of the order is dropped at ingest and never reaches the pipeline.
    name: 'refund: a second Refunded callback for the order still leaves one event',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(approveThenRefund('chk_r3'));

        await run(ingestAll([refunded('chk_r3', '100')]));

        await expectRows(query, [
          [
            `SELECT count(*) FROM charges WHERE status = 'refunded'`,
            '1',
            'the second callback stored no charge',
          ],
          ...oneRefundOf('chk_r3'),
        ]);
      }),
  },
  {
    name: 'refund: a bind queued before the refund was attributed is refused when it is dispatched',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        const logs = capturingLogs(staleBindAfterResolution);
        await run(logs.effect);

        assert.ok(
          logs.messages.includes(
            'REBIND_REFUSED the charge is a refund; nothing written',
          ),
          'the worker logged the refusal',
        );
        await expectRows(query, [
          [
            `SELECT status FROM messages WHERE "messageType" = 'payment_rebind'`,
            'success',
            'the stale bind was dispatched and completed, not failed',
          ],
          [
            `SELECT count(*) FROM charge_fixations f JOIN charges c ON c.id = f."incomingEventId" WHERE c.status = 'refunded'`,
            '0',
            'no fixation for the refund',
          ],
          [countOf('recurring_payment_succeeded'), '0', 'no success event'],
          [countOf('payment_refunded'), '1', 'the refund was reported'],
          [
            `SELECT status || ':' || coalesce("boundPaymentId"::text, 'none') FROM quarantine_records`,
            'resolved:none',
            'resolved by the refund, bound to nothing',
          ],
        ]);
      }),
  },
  {
    name: 'refund: charges:reprocess-refunded run twice reports, emits once, and the second run emits nothing',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(quarantinedBeforeOriginals);

        const first = runCommand();
        const second = runCommand();

        console.log(`    first:  ${first.line}`);
        console.log(`    second: ${second.line}`);
        assert.deepEqual(
          first.report,
          reportOf({ selected: 3, emitted: 1, skipped: 1, unresolved: 1 }),
        );
        assert.deepEqual(
          second.report,
          reportOf({ selected: 2, skipped: 1, unresolved: 1 }),
        );
        await expectRows(query, [
          ...oneRefundOf('chk_backfill'),
          [
            `SELECT q.status || ':' || c."matchResult" FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = 'chk_backfill'`,
            'resolved:matched',
            'the backfilled refund left the quarantine',
          ],
          [
            `SELECT string_agg(c."externalRef", ',' ORDER BY c."externalRef") FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE q.status = 'open'`,
            'chk_smoke,chk_unknown',
            'the smoke-test and unknown refunds stay quarantined',
          ],
          [
            `SELECT count(*) FROM event_deliveries d JOIN domain_events e ON e.id = d."eventId" WHERE e.name = 'payment_refunded'`,
            '1',
            'the emitted refund fanned out to the sink',
          ],
        ]);
      }),
  },
  {
    name: 'refund: a failure after the publish rolls the whole refund settlement back',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(quarantinedBeforeOriginals);
        const deliveriesBefore = (
          await query('SELECT count(*) FROM event_deliveries')
        ).trim();
        await query(FAIL_RESOLVE);

        const report = await run(reprocess);

        assert.deepEqual(
          report,
          reportOf({ selected: 3, failed: 1, skipped: 1, unresolved: 1 }),
        );
        await expectRows(query, [
          [countOf('payment_refunded'), '0', 'no refund event persisted'],
          [
            'SELECT count(*) FROM event_deliveries',
            deliveriesBefore,
            'no delivery fanned out',
          ],
          [
            `SELECT q.status || ':' || c."matchResult" FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = 'chk_backfill'`,
            'open:quarantined',
            'the refund is still quarantined',
          ],
        ]);
      }),
  },
];
