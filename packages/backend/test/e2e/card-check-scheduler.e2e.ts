import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { SqlClient } from '@effect/sql';
import type { Payment } from '@billing-service/shared';
import { Deferred, Effect, Option } from 'effect';

import { loadConfig } from '@/config.js';
import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  drain,
  fastForwardRetries,
  makeGate,
  type OnWorker,
  openGate,
  runFor,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import { WayForPay } from '@/modules/wayforpay/client.js';
import { mapTransaction } from '@/modules/wayforpay/mapping.js';

import type { Scenario } from './http-harness.js';
import {
  defer,
  handover,
  nextOf,
  operatorCookie,
  operatorDefer,
  withCardCheckApp,
} from './card-check.e2e.js';
import {
  activate,
  assertUntouched,
  CHARGE_CREATED,
  gatedTick,
  makeDue,
  markersOf,
  refusalOf,
  registerWithDefers,
} from './card-check-races.e2e.js';
import { type Http, httpContext, scalar, withEnv } from './prolong.e2e.js';

/**
 * The scheduled first charge of a card-check payment against the copies of its receipt:
 * the poller's copy shares the scheduler's queue key and can take it before the approval
 * has committed, and an operator defer must not open the handover while the CHARGE is in
 * flight. Lock barriers on a real Postgres; then one run through the real WayForPay
 * client against a local CHARGE endpoint (billing stubs the provider at the HTTP boundary,
 * not with MSW).
 */

const DAY = 24 * 60 * 60 * 1000;
const P4W = 28 * DAY;

/** The due row as the scheduler will read it, and the order it will charge. */
const dueOrder = async (http: Http, run: OnWorker, payment: Payment) => {
  await makeDue(http, payment.id);
  const due = Option.getOrThrow(
    await run(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        makePaymentRepo(sql).findById(payment.id),
      ),
    ),
  );
  return {
    due,
    ref: `${PAYMENT_ORDER_PREFIX}${payment.id}_${due.nextPaymentDate.getTime().toString()}`,
  };
};

/** The poller's journal copy of that CHARGE, as the poller maps it. */
const pollerCopy = (ref: string) => {
  const charge = mapTransaction({
    transactionType: 'CHARGE',
    orderReference: ref,
    createdDate: CHARGE_CREATED,
    amount: '50',
    currency: 'USD',
    transactionStatus: 'Approved',
  });
  assert.ok(charge !== null, 'a CHARGE row maps to a charge');
  return charge;
};

const ingest = (run: OnWorker, ref: string) =>
  run(
    Effect.flatMap(ChargePipeline, (pipeline) =>
      pipeline.ingest(pollerCopy(ref)),
    ),
  );

/** A worker pass that leaves a retrying receipt in `retry`, then one more after the
 * retries are made due. */
const retryPass = (run: OnWorker) =>
  run(
    Effect.gen(function* () {
      yield* fastForwardRetries(yield* SqlClient.SqlClient);
      yield* runFor(1);
    }),
  );

const ms = (http: Http, sql: string) =>
  scalar(http, `SELECT (extract(epoch FROM (${sql})) * 1000)::bigint`);

/** One fixation, one success, marked first, reporting the approval's credited end. */
const assertSettledOnce = async (
  http: Http,
  contact: string,
  expectedEnd: number,
) => {
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${contact}'`,
    ),
    '1',
    'one fixation',
  );
  assert.equal(
    await markersOf(http, contact),
    'true',
    'one success, marked first',
  );
  assert.equal(
    await ms(
      http,
      `SELECT (payload->>'periodEnd')::timestamptz FROM domain_events WHERE "externalUserId" = '${contact}' AND name = 'recurring_payment_succeeded'`,
    ),
    String(expectedEnd),
    "coverage = the approval's credited end",
  );
};

const receiptMessages = (http: Http, ref: string) =>
  scalar(
    http,
    `SELECT count(*) FROM messages WHERE "messageType" = 'payment_event_received' AND "idemKey" LIKE 'w4p:${ref}%'`,
  );

const pollerBeforeApproval = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccs-before');
  const { due, ref } = await dueOrder(http, run, payment);
  const gate = await run(makeGate);
  const ticking = run(gatedTick({ charge: gate }));
  await run(Deferred.await(gate.reached));
  await ingest(run, ref);
  await run(drain);
  const beforeApproval = await markersOf(http, 'sp:ccs-before');

  await run(openGate(gate));
  await ticking;
  await retryPass(run);

  assert.equal(beforeApproval, '', 'nothing settled before the approval');
  assert.equal(
    await receiptMessages(http, ref),
    '1',
    'one receipt under the shared key',
  );
  await assertSettledOnce(
    http,
    'sp:ccs-before',
    due.currentPeriodEnd.getTime() + P4W,
  );
};

const pollerDuringApproval = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccs-during');
  const { due, ref } = await dueOrder(http, run, payment);
  const gate = await run(makeGate);
  const ticking = run(gatedTick({ approval: gate }));
  await run(Deferred.await(gate.reached));
  await ingest(run, ref);
  await run(drain);
  const duringApproval = await markersOf(http, 'sp:ccs-during');

  await run(openGate(gate));
  await ticking;
  await retryPass(run);

  assert.equal(
    duringApproval,
    '',
    'nothing settled while the approval was open',
  );
  assert.equal(
    await receiptMessages(http, ref),
    '1',
    'one receipt under the shared key',
  );
  await assertSettledOnce(
    http,
    'sp:ccs-during',
    due.currentPeriodEnd.getTime() + P4W,
  );
};

const pollerRaces: Scenario = {
  name: "card check scheduler: the poller's receipt copy before and during the approval settles once, marked, with the approval's coverage",
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccs-poller');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await run(registerWithDefers);
        await pollerBeforeApproval(on, run);
        await pollerDuringApproval(on, run);
      }),
    );
  },
};

const operatorDuringCharge = async (http: Http, run: OnWorker) => {
  const cookie = await operatorCookie(http);
  const { payment } = await activate(http, run, 'sp:ccs-op');
  await makeDue(http, payment.id);
  const gate = await run(makeGate);
  const ticking = run(gatedTick({ charge: gate }));
  await run(Deferred.await(gate.reached));
  const before = await nextOf(http, payment.id);

  const byOperator = await refusalOf(
    await operatorDefer(http, cookie, payment.id, { days: 3 }),
  );
  const byHandover = await refusalOf(
    await defer(http, payment.id, {
      body: handover(new Date(Date.now() + 5 * DAY)),
    }),
  );

  await assertUntouched(http, payment.id, before);
  await run(openGate(gate));
  await ticking;
  assert.deepEqual(
    [byOperator, byHandover],
    [
      [422, 'charge_in_flight'],
      [422, 'charge_in_flight'],
    ],
    'the operator defer cannot open the handover while the CHARGE is in flight',
  );
};

const operatorScenario: Scenario = {
  name: 'card check scheduler: during a held CHARGE an operator defer and then a handover defer are both refused',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccs-op');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await run(registerWithDefers);
        await operatorDuringCharge(on, run);
      }),
    );
  },
};

// ---------------------------------------------------------------------------------
// the CHARGE wire, through the real WayForPay client
// ---------------------------------------------------------------------------------

/** A local WayForPay API that answers every CHARGE Approved and records the bodies. */
const chargeEndpoint = async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          orderReference: body['orderReference'],
          transactionStatus: 'Approved',
          reasonCode: 1100,
          createdDate: Number(CHARGE_CREATED),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { bodies, server, url: `http://127.0.0.1:${port.toString()}` };
};

/** One scheduler tick that charges through the worker's real WayForPay client. */
const wireTick = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* scheduleTick(
    {
      subs: makePaymentRepo(sql),
      client: yield* WayForPay,
      ingest: (yield* ChargePipeline).ingest,
      publish: (yield* Outbox).publish,
      lapse: () => Effect.void,
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.void,
      claimAdvance: ledgerClaimAdvance(sql),
      mintPayNow: () => Effect.die('unused'),
      recentProlongClaim: () => Effect.succeed(Option.none()),
      createManualCheckout: () => Effect.die('a card-check sub has a token'),
    },
    {
      intervalSeconds: 60,
      batchSize: 10,
      upcomingChargeNoticeDays: [],
      payNowClaimGraceSeconds: 3600,
    },
  );
  yield* drain;
});

const chargeWire: Scenario = {
  name: 'card check scheduler: the first charge goes out as a WayForPay CHARGE of the plan on the verify token, and settles marked',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccs-wire');
    const endpoint = await chargeEndpoint();
    try {
      await withCardCheckApp(http, (on) =>
        withEnv({ W4P_API_URL: endpoint.url }, () =>
          withWorker(loadConfig(), async (run) => {
            await run(registerWithDefers);
            const { payment } = await activate(on, run, 'sp:ccs-wire');
            await makeDue(on, payment.id);
            await run(wireTick);
          }),
        ),
      );
    } finally {
      endpoint.server.close();
    }
    const [body] = endpoint.bodies;
    assert.equal(endpoint.bodies.length, 1, 'one CHARGE');
    assert.deepEqual(
      [
        body?.['transactionType'],
        body?.['amount'],
        body?.['currency'],
        body?.['recToken'],
      ],
      ['CHARGE', 50, 'USD', 'tok_cc'],
      'the plan price on the verify token',
    );
    assert.equal(
      await markersOf(http, 'sp:ccs-wire'),
      'true',
      'settled and marked first',
    );
  },
};

export const cardCheckSchedulerScenarios: readonly Scenario[] = [
  pollerRaces,
  operatorScenario,
  chargeWire,
];
