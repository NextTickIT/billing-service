import { SqlClient } from '@effect/sql';
import { CheckoutSessionKind, PaymentStatus } from '@billing-service/shared';
import { Effect } from 'effect';

import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  DAY,
  drain,
  type EffectScenario,
  expectRows,
  registerHandlers,
  seedSub,
  withWorker,
  type WorkerContext,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { manualRenewalSession } from '@/modules/checkout/domain.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { pollTick } from '@/modules/wayforpay/poller.js';

/**
 * `chargeKind` on the success events is what STARTED the charge, not the path that
 * settled it (owner decision 2026-10-21). A renewal the scheduler started is `scheduled`
 * whether the scheduler's own call, the WayForPay callback or the poller brings it into
 * the pipeline; any checkout session — a first payment, a manual-renewal link — is
 * `checkout`.
 */

/** name | source | chargeKind of the one success event. */
const successSql = `SELECT name || '|' || (payload->>'source') || '|' || (payload->>'chargeKind') FROM domain_events WHERE name LIKE '%_succeeded'`;

const FAR = new Date('2030-01-01T00:00:00Z');

/** A due recurring card payment, and the orderReference the scheduler mints for it. */
const seedDue = (externalUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sub = yield* seedSub(makePaymentRepo(sql), {
      externalUserId,
      end: new Date(Date.now() - DAY),
      token: 'tok',
    });
    return {
      sub,
      orderReference: `${PAYMENT_ORDER_PREFIX}${sub.id}_${sub.nextPaymentDate.getTime().toString()}`,
    };
  });

const bySchedulerCall = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  yield* seedDue('sp:kind-sched');
  yield* scheduleTick(
    {
      subs: makePaymentRepo(sql),
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
  yield* drain;
});

const byCallback = Effect.gen(function* () {
  yield* registerHandlers;
  const { orderReference } = yield* seedDue('sp:kind-cb');
  yield* (yield* ChargePipeline).ingest(
    normalizeCallback({
      orderReference,
      amount: '300',
      currency: 'UAH',
      transactionStatus: 'Approved',
      createdDate: '1700000000',
    }),
  );
  yield* drain;
});

const byPoller = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const { orderReference } = yield* seedDue('sp:kind-poll');
  yield* pollTick(
    {
      client: {
        transactionList: () =>
          Effect.succeed([
            {
              transactionType: 'CHARGE',
              orderReference,
              createdDate: '1700000000',
              amount: '300.00',
              currency: 'UAH',
              transactionStatus: 'Approved',
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

const manualRenewalLinkByCallback = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const sub = yield* seedSub(makePaymentRepo(sql), {
    externalUserId: 'sp:kind-manual',
    end: new Date(Date.now() - DAY),
    status: PaymentStatus.PastDue,
    token: 'tok',
  });
  yield* makeCheckoutRepo(sql).insert(
    manualRenewalSession(sub, 'chk_kind_manual', FAR, `manual:${sub.id}`),
  );
  yield* (yield* ChargePipeline).ingest(
    normalizeCallback({
      orderReference: 'chk_kind_manual',
      amount: '300',
      currency: 'UAH',
      transactionStatus: 'Approved',
      recToken: 'tok_new',
      createdDate: '1700000000',
    }),
  );
  yield* drain;
});

const firstCheckout = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  yield* makeCheckoutRepo(sql).insert({
    id: 'chk_kind_first',
    paymentId: null,
    externalUserId: 'sp:kind-first',
    amount: 30000,
    currency: 0,
    period: 'P1M',
    kind: CheckoutSessionKind.Checkout,
    recurring: true,
    successUrl: null,
    failureUrl: null,
    promo: null,
    renewal: null,
    origin: null,
    renewalOf: null,
    idempotencyKey: null,
    email: '',
    metadata: null,
    expiresAt: FAR,
  });
  yield* (yield* ChargePipeline).ingest(
    normalizeCallback({
      orderReference: 'chk_kind_first',
      amount: '300',
      currency: 'UAH',
      transactionStatus: 'Approved',
      recToken: 'tok_first',
      createdDate: '1700000000',
    }),
  );
  yield* drain;
});

const scenario = (
  name: string,
  drive: Effect.Effect<void, unknown, WorkerContext>,
  expected: string,
): EffectScenario => ({
  name: `chargeKind: ${name}`,
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      await run(drive);

      await expectRows(query, [[successSql, expected, name]]);
    }),
});

export const chargeKindScenarios: readonly EffectScenario[] = [
  scenario(
    'a scheduled renewal settled by the scheduler call is scheduled',
    bySchedulerCall,
    'recurring_payment_succeeded|wayforpay_charge|scheduled',
  ),
  scenario(
    'a scheduled renewal brought in by the WayForPay callback is scheduled',
    byCallback,
    'recurring_payment_succeeded|wayforpay_callback|scheduled',
  ),
  scenario(
    'a scheduled renewal brought in by the poller is scheduled',
    byPoller,
    'recurring_payment_succeeded|wayforpay_poller|scheduled',
  ),
  scenario(
    'a manual-renewal link paid through the callback is checkout',
    manualRenewalLinkByCallback,
    'recurring_payment_succeeded|wayforpay_callback|checkout',
  ),
  scenario(
    'a first checkout is checkout',
    firstCheckout,
    'initial_payment_succeeded|wayforpay_callback|checkout',
  ),
];
