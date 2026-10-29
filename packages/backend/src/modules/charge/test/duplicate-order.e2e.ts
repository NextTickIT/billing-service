import { SqlClient } from '@effect/sql';
import { Effect, Fiber } from 'effect';

import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import type { ChargeRepo } from '@/modules/charge/data-access.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  asPayload,
  awaitLockWait,
  type Check,
  DAY,
  drain,
  type EffectScenario,
  expectRows,
  type Gate,
  makeGate,
  openGate,
  pauseAt,
  registerHandlers,
  seedSub,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';

/**
 * One scheduled charge, two copies: the scheduler's own (`w4p:…|CHARGE|…`) and the
 * WayForPay callback for the same order (`w4pcb:…`). Different keys, so both are stored
 * and both match the same `sub_…` order. One charge must still be one payment fixation and
 * one `recurring_payment_succeeded`.
 */

const seedDue = (externalUserId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sub = yield* seedSub(makePaymentRepo(sql), {
      externalUserId,
      end: new Date(Date.now() - DAY),
      token: 'tok',
    });
    return `${PAYMENT_ORDER_PREFIX}${sub.id}_${sub.nextPaymentDate.getTime().toString()}`;
  });

const callbackCopy = (orderReference: string) =>
  normalizeCallback({
    orderReference,
    amount: '300',
    currency: 'UAH',
    transactionStatus: 'Approved',
    createdDate: '1700000000',
  });

const scheduleAndApprove = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
      mintPayNow: () => Effect.die('unused'),
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    {
      intervalSeconds: 60,
      batchSize: 10,
      upcomingChargeNoticeDays: [],
      payNowClaimGraceSeconds: 3600,
    },
  );
});

const schedulerThenCallback = Effect.gen(function* () {
  yield* registerHandlers;
  const orderReference = yield* seedDue('sp:dup-seq');
  yield* scheduleAndApprove;
  yield* drain;
  yield* (yield* ChargePipeline).ingest(callbackCopy(orderReference));
  yield* drain;
});

/** The repo, with its order lock held at `gate` once taken (inside the transaction). */
const holdingOrderLock = (repo: ChargeRepo, gate: Gate): ChargeRepo => ({
  ...repo,
  orderSettledByAnotherCopy: (externalRef, id) =>
    repo
      .orderSettledByAnotherCopy(externalRef, id)
      .pipe(Effect.tap(() => pauseAt(gate))),
});

/**
 * Copy A takes the order lock and parks inside its transaction; copy B is released only
 * once Postgres reports it waiting on that lock — no timing guess.
 */
const twoCopiesAtOnce = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orderReference = yield* seedDue('sp:dup-race');
  const gate = yield* makeGate;
  const copyA = yield* settlementHandler({
    repo: holdingOrderLock(makeChargeRepo(sql), gate),
  });
  const a = yield* Effect.fork(
    copyA(
      asPayload({
        ...callbackCopy(orderReference),
        source: 'wayforpay_charge',
        idemKey: `w4p:${orderReference}|CHARGE|1700000000`,
      }),
    ),
  );
  yield* gate.reached;
  const b = yield* Effect.fork(
    (yield* settlementHandler())(asPayload(callbackCopy(orderReference))),
  );
  yield* awaitLockWait(sql, '%pg_advisory_xact_lock%');
  yield* openGate(gate);
  yield* Fiber.join(Fiber.zip(a, b));
});

const oneChargeOneSuccess = (externalUserId: string): readonly Check[] => [
  [
    `SELECT count(*) FROM domain_events WHERE name = 'recurring_payment_succeeded' AND "externalUserId" = '${externalUserId}'`,
    '1',
    'one success event for one charge',
  ],
  [
    `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${externalUserId}'`,
    '1',
    'one payment fixation',
  ],
  [
    `SELECT string_agg("matchResult", ',') FROM charges`,
    'matched,matched',
    'both copies stored and closed',
  ],
];

export const duplicateOrderScenarios: readonly EffectScenario[] = [
  {
    name: 'one order, two copies: a callback after the scheduler settled it writes and publishes nothing',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(schedulerThenCallback);

        await expectRows(query, oneChargeOneSuccess('sp:dup-seq'));
      }),
  },
  {
    name: 'one order, two copies at once: the second waits on the order lock and then writes nothing',
    run: ({ config, query }) =>
      withWorker(config, async (run) => {
        await run(twoCopiesAtOnce);

        await expectRows(query, oneChargeOneSuccess('sp:dup-race'));
      }),
  },
];
