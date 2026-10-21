import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import {
  drain,
  type EffectScenario,
  expectRows,
  registerHandlers,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

/**
 * The scheduler settles a renewal (advances the payment) and only then enqueues the
 * charge for the pipeline, which emits `recurring_payment_succeeded`. The row can move
 * while that message waits. The event must report what the charge bought, not the row as
 * it is when the message is processed.
 */
const seedDueAndCharge = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  yield* subs.insert({
    externalUserId: 'sp:settled',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: 0,
    recurring: true,
    currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-01-01T00:00:00Z'),
    recurringTokenRef: 'tok',
    firstFailureAt: null,
    retryAttempt: 0,
    metadata: { planCode: 'half_year' },
  });
  yield* scheduleTick(
    {
      subs,
      client: {
        charge: () =>
          Effect.succeed({
            transactionStatus: 'Approved',
            createdDate: '1700000000',
          }),
      },
      ingest: (yield* ChargePipeline).ingest,
      publish: (yield* Outbox).publish,
      lapse: () => Effect.void,
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.void,
      claimAdvance: ledgerClaimAdvance(sql),
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    { intervalSeconds: 60, batchSize: 10, upcomingChargeNoticeDays: [] },
  );
});

const succeededField = (field: string) =>
  `SELECT payload->>'${field}' FROM domain_events WHERE name = 'recurring_payment_succeeded'`;

const renewalReportsTheSettledWindow: EffectScenario = {
  name: 'settlement snapshot: a renewal event reports the period, method, window and metadata the charge settled, though the row changed before the pipeline ran',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(seedDueAndCharge);
      // While the charge message waits: a week's defer, a new declaration, and a plan and
      // method change (P1M card → P3M crypto).
      await query(
        `UPDATE payments SET "currentPeriodEnd" = '2026-02-08T00:00:00Z', "nextPaymentDate" = '2026-02-08T00:00:00Z', metadata = '{"planCode":"later"}'::jsonb, period = 'P3M', method = 1`,
      );
      await run(drain);

      await expectRows(query, [
        [
          succeededField('periodStart'),
          '2026-01-01T00:00:00.000Z',
          'the window began where the last one ended',
        ],
        [
          succeededField('periodEnd'),
          '2026-02-01T00:00:00.000Z',
          'one month bought, not the deferred end',
        ],
        [
          succeededField('nextPaymentDate'),
          '2026-02-01T00:00:00.000Z',
          'the next charge as settled',
        ],
        [
          `SELECT (payload->>'period') || '|' || (payload->>'method') FROM domain_events WHERE name = 'recurring_payment_succeeded'`,
          'P1M|0',
          'the period and method it was charged on, not the changed plan',
        ],
        [
          `SELECT payload->'metadata'->>'planCode' FROM domain_events WHERE name = 'recurring_payment_succeeded'`,
          'half_year',
          'the declaration the payment carried at settlement',
        ],
      ]);
    }),
};

export const settlementScenarios: readonly EffectScenario[] = [
  renewalReportsTheSettledWindow,
];
