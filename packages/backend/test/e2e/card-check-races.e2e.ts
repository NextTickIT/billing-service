import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
} from '@billing-service/shared';
import { Deferred, Duration, Effect, Option } from 'effect';

import { loadConfig } from '@/config.js';
import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import type { Charge } from '@/modules/charge/contracts.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  asPayload,
  drain,
  type Gate,
  makeGate,
  type OnWorker,
  openGate,
  pauseAt,
  registerHandlers,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { prolongSession } from '@/modules/checkout/domain.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { deferNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_DEFER } from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';

import type { Scenario } from './http-harness.js';
import {
  auditRevisions,
  cardCheckBody,
  close,
  defer,
  deferredEvents,
  handover,
  nextOf,
  operatorCookie,
  operatorDefer,
  paymentsOf,
  statusAndReason,
  withCardCheckApp,
} from './card-check.e2e.js';
import {
  createSession,
  type Http,
  httpContext,
  type Json,
  pay,
  scalar,
  sessionIdOf,
} from './prolong.e2e.js';

/**
 * The card-check races, made deterministic with lock barriers on a real Postgres: one
 * side holds a row lock at a gate, the other is started and observed waiting on that lock
 * (`pg_stat_activity`), then the gate opens. Each pair goes through the production path
 * (the settlement handler as the worker builds it, the HTTP routes, the scheduler).
 */

const DAY = 24 * 60 * 60 * 1000;

/** The serviceUrl callback of a verify, normalised as the route does. */
const verify = (ref: string): Charge =>
  normalizeCallback({
    orderReference: ref,
    transactionStatus: 'WaitingAuthComplete',
    reasonCode: 1100,
    amount: '0',
    currency: 'UAH',
    recToken: 'tok_cc',
    createdDate: String(Math.floor(Date.now() / 1000)),
  });

/** An Approved card callback for a priced order (major units in `amount`). */
const approved = (ref: string, amount: string): Charge =>
  normalizeCallback({
    orderReference: ref,
    transactionStatus: 'Approved',
    amount,
    currency: 'USD',
    recToken: 'tok_cc',
    createdDate: String(Math.floor(Date.now() / 1000)),
  });

const settle = (charge: Charge) =>
  Effect.flatMap(settlementHandler(), (handle) => handle(asPayload(charge)));

/** Wait until at least `n` backends of this database wait on a lock. */
export const awaitWaiters = (n: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let i = 0; i < 500; i += 1) {
      const rows = yield* sql<{ readonly n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      if ((rows[0]?.n ?? 0) >= n) return;
      yield* Effect.sleep(Duration.millis(20));
    }
    return yield* Effect.die(`fewer than ${String(n)} lock waiters`);
  });

/** Hold `lock`'s row lock in its own transaction until the gate opens. */
const holdLock = (
  run: OnWorker,
  gate: Gate,
  lock: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>,
): Promise<unknown> =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.andThen(lock(sql), pauseAt(gate))),
    ),
  );

const reached = (run: OnWorker, gate: Gate) =>
  run(Deferred.await(gate.reached));

/** A card-check payment for `contact`, activated through create → verify. */
export const activate = async (
  http: Http,
  run: OnWorker,
  contact: string,
): Promise<{ readonly session: string; readonly payment: Payment }> => {
  const session = await sessionIdOf(
    await createSession(http, cardCheckBody(contact)),
    `create ${contact}`,
  );
  await run(settle(verify(session)));
  const payment = await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makePaymentRepo(sql).findActiveRecurringByExternalUser(contact),
    ),
  );
  return { session, payment: Option.getOrThrow(payment) };
};

// ---------------------------------------------------------------------------------
// close vs verify, both orders, truly concurrent
// ---------------------------------------------------------------------------------

const lockSession = (id: string) => (sql: SqlClient.SqlClient) =>
  sql`SELECT id FROM checkout_sessions WHERE id = ${id} FOR UPDATE`;

const closeBeforeVerify = async (http: Http, run: OnWorker) => {
  const id = await sessionIdOf(
    await createSession(http, cardCheckBody('sp:ccr-cv')),
    'create',
  );
  const gate = await run(makeGate);
  const holder = holdLock(run, gate, lockSession(id));
  await reached(run, gate);
  const closing = close(http, id);
  await run(awaitWaiters(1));
  const verifying = run(settle(verify(id)));
  await run(awaitWaiters(2));

  await run(openGate(gate));

  await holder;
  const closed = await closing;
  await verifying;
  assert.equal(closed.status, 200, 'the close queued first wins');
  assert.equal(await paymentsOf(http, 'sp:ccr-cv'), '0', 'no activation');
  assert.equal(
    await statusAndReason(http, id),
    `${String(CheckoutSessionStatus.Closed)}|superseded`,
    'closed, not reopened',
  );
};

const verifyBeforeClose = async (http: Http, run: OnWorker) => {
  const id = await sessionIdOf(
    await createSession(http, cardCheckBody('sp:ccr-vc')),
    'create',
  );
  const gate = await run(makeGate);
  const holder = holdLock(run, gate, lockSession(id));
  await reached(run, gate);
  const verifying = run(settle(verify(id)));
  await run(awaitWaiters(1));
  const closing = close(http, id);
  await run(awaitWaiters(2));

  await run(openGate(gate));

  await holder;
  await verifying;
  const closed = await closing;
  assert.equal(closed.status, 409, 'a close after the activation → 409');
  assert.equal(await paymentsOf(http, 'sp:ccr-vc'), '1', 'activated once');
};

const closeVsVerify: Scenario = {
  name: 'card check races: close vs verify in both orders, concurrent under a held session lock',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-close');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await closeBeforeVerify(on, run);
        await verifyBeforeClose(on, run);
      }),
    );
  },
};

// ---------------------------------------------------------------------------------
// reissue: never for a card check; never reopens a row settled meanwhile
// ---------------------------------------------------------------------------------

const intentLike = (
  from: NewCheckoutSession,
  id: string,
): NewCheckoutSession => ({ ...from, id, idempotencyKey: null });

const baseSession = (
  id: string,
  contact: string,
  over: Partial<NewCheckoutSession> = {},
): NewCheckoutSession => ({
  id,
  externalUserId: contact,
  amount: 5000,
  currency: 1,
  period: 'P4W',
  method: PaymentMethod.Card,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  options: null,
  origin: 'migration',
  renewalOf: null,
  metadata: null,
  startsAt: new Date(Date.now() + 10 * DAY),
  payableUntil: null,
  lockMethod: true,
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(Date.now() + DAY),
  ...over,
});

const reissueAgainstClose = async (http: Http, run: OnWorker) => {
  const original = baseSession('chk_ccr-reissue-cc', 'sp:ccr-re', {
    firstCharge: 'card_check',
  });
  await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).insert(original),
    ),
  );
  const gate = await run(makeGate);
  const holder = holdLock(
    run,
    gate,
    (sql) =>
      sql`UPDATE checkout_sessions SET status = ${CheckoutSessionStatus.Closed}, "closedReason" = 'superseded' WHERE id = ${original.id}`,
  );
  await reached(run, gate);
  // The pre-fix path: a re-issue on the same terms while the close is uncommitted.
  const reissued = await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).reissueLapsed(
        intentLike(original, 'chk_ccr-reissue-new'),
      ),
    ),
  );

  await run(openGate(gate));

  await holder;
  await run(settle(verify(original.id)));
  assert.notEqual(reissued, original.id, 'the card check is never handed back');
  assert.equal(
    await statusAndReason(http, original.id),
    `${String(CheckoutSessionStatus.Closed)}|superseded`,
    'the close stands',
  );
  assert.equal(await paymentsOf(http, 'sp:ccr-re'), '0', 'no activation');
};

const reissueAgainstCompletion = async (http: Http, run: OnWorker) => {
  const original = baseSession('chk_ccr-reissue-fp', 'sp:ccr-fp', {
    lockMethod: false,
  });
  await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).insert(original),
    ),
  );
  const gate = await run(makeGate);
  const holder = holdLock(run, gate, (sql) =>
    makeCheckoutRepo(sql).completeIfOpen(original.id),
  );
  await reached(run, gate);
  const reissuing = run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).reissueLapsed(
        intentLike(original, 'chk_ccr-reissue-fp-new'),
      ),
    ),
  );
  await run(awaitWaiters(1));

  await run(openGate(gate));

  await holder;
  const reissued = await reissuing;
  assert.equal(reissued, 'chk_ccr-reissue-fp-new', 'a fresh session instead');
  assert.equal(
    await statusAndReason(http, original.id),
    `${String(CheckoutSessionStatus.Completed)}|`,
    'the completed row was not reset to Created',
  );
};

const lapsedCardCheckPay = async (http: Http) => {
  const id = await sessionIdOf(
    await createSession(http, cardCheckBody('sp:ccr-lapsed')),
    'create',
  );
  await http.query(
    `UPDATE checkout_sessions SET "expiresAt" = now() - interval '1 minute' WHERE id = '${id}'`,
  );

  const res = await pay(http, id, PaymentMethod.Card);

  assert.equal(res.status, 409, 'a lapsed card check is not re-issued');
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM checkout_sessions WHERE "externalUserId" = 'sp:ccr-lapsed'`,
    ),
    '1',
    'no new session',
  );
};

const reissueScenario: Scenario = {
  name: 'card check races: no re-issue of a card check; a re-issue never reopens a row closed or completed under it',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-reissue');
    await withCardCheckApp(http, async (on) => {
      await lapsedCardCheckPay(on);
      await withWorker(loadConfig(), async (run) => {
        await reissueAgainstClose(on, run);
        await reissueAgainstCompletion(on, run);
      });
    });
  },
};

// ---------------------------------------------------------------------------------
// settlement vs handover, and two settlements on one payment
// ---------------------------------------------------------------------------------

/** The settlement handler whose payment lock (the applier's `lockById`) parks at `gate`
 * once it holds the lock. */
const gatedSettle = (gate: Gate, charge: Charge) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payments = makePaymentRepo(sql);
    const handle = yield* settlementHandler({
      payments: {
        ...payments,
        lockById: (id) =>
          Effect.tap(payments.lockById(id), () => pauseAt(gate)),
      },
    });
    return yield* handle(asPayload(charge));
  });

const prolongLink = (run: OnWorker, sub: Payment, id: string) =>
  run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).insert(
        prolongSession(sub, id, new Date(Date.now() + DAY), null),
      ),
    ),
  );

export const markersOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT string_agg(coalesce(payload->>'cardCheckFirstCharge', '-'), ',' ORDER BY coalesce(payload->>'cardCheckFirstCharge', '-') DESC) FROM domain_events WHERE "externalUserId" = '${contact}' AND name = 'recurring_payment_succeeded'`,
  );

const settlementThenHandover = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccr-sh');
  await prolongLink(run, payment, 'chk_ccr-sh-prolong');
  const gate = await run(makeGate);
  const settling = run(
    gatedSettle(gate, approved('chk_ccr-sh-prolong', '50.00')),
  );
  await reached(run, gate);
  const deferring = defer(http, payment.id, {
    body: handover(new Date(payment.nextPaymentDate.getTime() + DAY)),
  });
  await run(awaitWaiters(1));

  await run(openGate(gate));

  await settling;
  const res = await deferring;
  const after = await nextOf(http, payment.id);
  assert.deepEqual(
    [res.status, ((await res.json()) as Json)['code']],
    [422, 'charged'],
    'the handover waited for the settlement and saw its money',
  );
  assert.equal(after.split('|')[2], '0', 'no revision');
  assert.equal(await auditRevisions(http, payment.id), '', 'no audit');
};

const twoSettlements = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccr-two');
  await prolongLink(run, payment, 'chk_ccr-two-a');
  await prolongLink(run, payment, 'chk_ccr-two-b');
  const gate = await run(makeGate);
  const first = run(gatedSettle(gate, approved('chk_ccr-two-a', '50.00')));
  await reached(run, gate);
  const second = run(gatedSettle(gate, approved('chk_ccr-two-b', '50.00')));
  await run(awaitWaiters(1));

  await run(openGate(gate));

  await Promise.all([first, second]);
  assert.equal(
    await markersOf(http, 'sp:ccr-two'),
    'true,-',
    'two successes, exactly one marked first',
  );
};

const settlementRaces: Scenario = {
  name: 'card check races: settlement vs handover under the payment lock; two settlements on one payment mark one first charge',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-settle');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await run(registerHandlers);
        await settlementThenHandover(on, run);
        await twoSettlements(on, run);
      }),
    );
  },
};

// ---------------------------------------------------------------------------------
// the scheduler gap: in flight, then approved but not yet received
// ---------------------------------------------------------------------------------

/** One real-clock scheduler tick whose WayForPay CHARGE parks at `gate` and then
 * approves. No drain: the receipt stays in the queue. */
/** The createdDate the stubbed CHARGE answers with: it keys the receipt, and the poller
 * derives the same key from the journal row. */
export const CHARGE_CREATED = '1790000000';

interface TickGates {
  /** Parks inside the CHARGE call, before the approval starts. */
  readonly charge?: Gate;
  /** Parks inside the approval transaction, after it credited the period. */
  readonly approval?: Gate;
}

/** A gate that is already open, for a tick that should not park. */
const parkAt = (gate: Gate | undefined) =>
  gate === undefined ? Effect.void : pauseAt(gate);

/** One real-clock scheduler tick whose WayForPay CHARGE approves, optionally parking at
 * the gates. No drain: the receipt stays in the queue. */
export const gatedTick = (gates: TickGates) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payments = makePaymentRepo(sql);
    return yield* scheduleTick(
      {
        subs: {
          ...payments,
          markFirstMoney: (id, ref) =>
            Effect.andThen(
              payments.markFirstMoney(id, ref),
              parkAt(gates.approval),
            ),
        },
        client: {
          charge: () =>
            parkAt(gates.charge).pipe(
              Effect.as({
                transactionStatus: 'Approved',
                createdDate: CHARGE_CREATED,
              }),
            ),
        },
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
  });

/** Time passes: the first charge of `paymentId` is now due (a minute ago). */
export const makeDue = (http: Http, paymentId: string) =>
  http.query(
    `UPDATE payments SET "nextPaymentDate" = now() - interval '1 minute', "currentPeriodEnd" = now() - interval '1 minute' WHERE id = '${paymentId}'`,
  );

export const refusalOf = async (res: Response) => [
  res.status,
  ((await res.json()) as Json)['code'],
];

/** Nothing a refused handover could have written: dates, revision, audit, notify. */
export const assertUntouched = async (
  http: Http,
  id: string,
  before: string,
) => {
  assert.equal(await nextOf(http, id), before, 'dates and revision unchanged');
  assert.equal(before.split('|')[2], '0', 'revision 0');
  assert.equal(await auditRevisions(http, id), '', 'no audit');
  assert.equal(
    await scalar(
      http,
      `SELECT count(*) FROM messages WHERE "messageType" = 'payment_defer'`,
    ),
    '0',
    'no notification queued',
  );
};

const schedulerGap = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccr-gap');
  const to = { body: handover(new Date(Date.now() + 5 * DAY)) };
  const [gate] = await Promise.all([run(makeGate), makeDue(http, payment.id)]);
  const ticking = run(gatedTick({ charge: gate }));
  await reached(run, gate);

  const inFlight = await refusalOf(await defer(http, payment.id, to));

  await run(openGate(gate));
  await ticking;
  const before = await nextOf(http, payment.id);
  const received = await refusalOf(await defer(http, payment.id, to));
  assert.deepEqual(inFlight, [422, 'charge_in_flight'], 'refused mid-CHARGE');
  assert.deepEqual(
    received,
    [422, 'charged'],
    'refused once approved, though the receipt is still queued',
  );
  await assertUntouched(http, payment.id, before);
  await run(drain);
  assert.equal(
    await markersOf(http, 'sp:ccr-gap'),
    'true',
    'the receipt, once processed, carries the marker',
  );
};

const schedulerScenario: Scenario = {
  name: 'card check races: a handover refuses while the scheduler CHARGE is in flight and after it is approved, before the receipt is processed',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-gap');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await run(registerHandlers);
        await schedulerGap(on, run);
      }),
    );
  },
};

// ---------------------------------------------------------------------------------
// a small card change is not first money
// ---------------------------------------------------------------------------------

const smallChange = (sub: Payment, id: string): NewCheckoutSession => ({
  ...baseSession(id, sub.externalUserId, {
    kind: CheckoutSessionKind.CardChange,
    paymentId: sub.id,
    amount: 1,
    origin: 'card_change',
    startsAt: null,
    lockMethod: false,
  }),
});

const cardChangeThenPlan = async (http: Http, run: OnWorker) => {
  const { payment } = await activate(http, run, 'sp:ccr-change');
  await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makeCheckoutRepo(sql).insert(smallChange(payment, 'chk_ccr-change')),
    ),
  );
  await run(settle(approved('chk_ccr-change', '0.01')));
  const between = await defer(http, payment.id, {
    body: handover(new Date(payment.nextPaymentDate.getTime() + DAY)),
  });
  await makeDue(http, payment.id);
  await run(gatedTick({}));
  await run(drain);

  assert.equal(between.status, 202, 'the handover is still allowed after it');
  assert.equal(
    await scalar(
      http,
      `SELECT string_agg(coalesce(payload->>'cardCheckFirstCharge', '-') || ':' || coalesce(payload->>'periodEnd', 'null'), ',' ORDER BY "createdAt", ctid) FROM domain_events WHERE "externalUserId" = 'sp:ccr-change' AND name = 'recurring_payment_succeeded'`,
    ).then((v) => v.replace(/:\d{4}-[^,]+/g, ':period')),
    '-:null,true:period',
    'the card change credits nothing and is not marked; the plan charge is',
  );
};

/** The worker handlers plus the `payment_defer` notify, as the worker registers them. */
export const registerWithDefers = Effect.gen(function* () {
  yield* registerHandlers;
  const registry = yield* TaskRegistry;
  yield* registry.register(PAYMENT_DEFER, deferNotify((yield* Outbox).publish));
});

const smallChangeScenario: Scenario = {
  name: 'card check: a small paid card change is not first money; the scheduled plan charge is',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-change');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), async (run) => {
        await run(registerWithDefers);
        await cardChangeThenPlan(on, run);
      }),
    );
  },
};

// ---------------------------------------------------------------------------------
// concurrent defers through the routes
// ---------------------------------------------------------------------------------

const concurrentDefers = async (http: Http, run: OnWorker) => {
  const cookie = await operatorCookie(http);
  const { payment } = await activate(http, run, 'sp:ccr-rev');
  const gate = await run(makeGate);
  const holder = holdLock(
    run,
    gate,
    (sql) => sql`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`,
  );
  await reached(run, gate);
  const byOperator = operatorDefer(http, cookie, payment.id, { days: 2 });
  const byHandover = defer(http, payment.id, {
    body: handover(new Date(payment.nextPaymentDate.getTime() + 3 * DAY)),
  });
  await run(awaitWaiters(2));

  await run(openGate(gate));

  await holder;
  await assertTwoRevisions(http, payment.id, [byOperator, byHandover]);
};

const assertTwoRevisions = async (
  http: Http,
  id: string,
  calls: readonly Promise<Response>[],
) => {
  const [first, second] = await Promise.all(calls);
  assert.ok(first !== undefined && second !== undefined, 'two answers');
  const bodies = [(await first.json()) as Json, (await second.json()) as Json];
  assert.deepEqual([first.status, second.status], [202, 202], 'both applied');
  assert.deepEqual(
    bodies.map((b) => b['revision']).sort(),
    [1, 2],
    'distinct, increasing revisions',
  );
  assert.equal(
    (await auditRevisions(http, id))
      .split(',')
      .map((r) => r.split(':')[0])
      .sort()
      .join(','),
    '1,2',
    'one audit row per revision',
  );
  assert.equal((await nextOf(http, id)).split('|')[2], '2', 'the row');
  assert.equal(await deferredEvents(http, id), '', 'not yet notified');
};

const revisionScenario: Scenario = {
  name: 'defer races: an operator and a handover defer queued on one payment lock take revisions 1 and 2',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'ccr-rev');
    await withCardCheckApp(http, (on) =>
      withWorker(loadConfig(), (run) => concurrentDefers(on, run)),
    );
  },
};

export const cardCheckRaceScenarios: readonly Scenario[] = [
  closeVsVerify,
  reissueScenario,
  settlementRaces,
  schedulerScenario,
  smallChangeScenario,
  revisionScenario,
];
