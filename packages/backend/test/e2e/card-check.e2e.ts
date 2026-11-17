import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionStatus,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';

import { buildApp } from '@/app.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { registerHandlers, runFor } from '@/modules/charge/test/e2e-harness.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { deferNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_DEFER } from '@/modules/payment/contracts.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';

import {
  ADMIN_TOKEN,
  MERCHANT_ACCOUNT,
  postJson,
  type Scenario,
  signCallback,
} from './http-harness.js';
import {
  cardOrderOf,
  createSession,
  drainQueue,
  eventsOf,
  type Http,
  httpContext,
  type Json,
  onApp,
  onDb,
  pay,
  publicRead,
  scalar,
  sessionIdOf,
  w4pCallback,
  withEnv,
} from './prolong.e2e.js';

/**
 * HTTP e2e for card-check checkouts (plan wfp-migration-card-check §1, §6): admission,
 * the create echo and identity, the public read, the verify form, activation through the
 * real callback route and queue, the close endpoint, and the handover defer on the shared
 * service token, next to the operator defer it shares a route with. Plus the regressions
 * the plan names for the full-price and card-change paths.
 */

const DAY = 24 * 60 * 60 * 1000;
const PLAN = { amount: 5000, currency: 1, period: 'P4W' };

/** A second app over the same database with card checks admitted (plus `extraEnv`). */
export const withCardCheckApp = async (
  http: Http,
  body: (http: Http) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> => {
  await withEnv({ W4P_CARD_CHECK_ENABLED: 'true', ...extraEnv }, async () => {
    const app = await buildApp();
    try {
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      await body(await onApp(http, baseUrl));
    } finally {
      await app.close();
    }
  });
};

export const cardCheckBody = (contact: string, extra: Json = {}): Json => ({
  externalUserId: contact,
  ...PLAN,
  method: PaymentMethod.Card,
  lockMethod: true,
  startsAt: new Date(Date.now() + 10 * DAY).toISOString(),
  reportAs: 'renewal',
  firstCharge: 'card_check',
  ...extra,
});

/** The serviceUrl callback a WayForPay verify sends, signed, then a worker pass. */
export const verifyCallback = async (
  http: Http,
  ref: string,
  over: Record<string, string> = {},
): Promise<void> => {
  const res = await postJson(
    `${http.baseUrl}/api/providers/wayforpay/callback`,
    signCallback({
      merchantAccount: MERCHANT_ACCOUNT,
      orderReference: ref,
      amount: '0',
      currency: 'UAH',
      authCode: '',
      cardPan: '',
      transactionStatus: 'WaitingAuthComplete',
      reasonCode: '1100',
      recToken: 'tok_cc',
      createdDate: String(Math.floor(Date.now() / 1000)),
      ...over,
    }),
  );
  assert.equal(res.status, 200, `verify callback for ${ref} accepted`);
  await drainQueue();
};

export const bearer = (secret: string) => ({
  authorization: `Bearer ${secret}`,
});

export const paymentsOf = (http: Http, contact: string) =>
  scalar(
    http,
    `SELECT count(*) FROM payments WHERE "externalUserId" = '${contact}'`,
  );

export const statusAndReason = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT status || '|' || coalesce("closedReason", '') FROM checkout_sessions WHERE id = '${id}'`,
  );

// ---------------------------------------------------------------------------------
// create, read, pay, activate
// ---------------------------------------------------------------------------------

const admissionOff = async (http: Http) => {
  const res = await createSession(http, cardCheckBody('sp:cch-off'));

  assert.equal(res.status, 422, 'admission off → 422');
  assert.equal(
    ((await res.json()) as Json)['code'],
    'card_check_disabled',
    'with the code the caller branches on',
  );
};

const createEchoAndIdentity = async (http: Http): Promise<string> => {
  // One instant for every call: `startsAt` is part of the key's identity too.
  const fixed = { startsAt: new Date(Date.now() + 10 * DAY).toISOString() };
  const created = await createSession(
    http,
    cardCheckBody('sp:cch-a', fixed),
    'cch-key',
  );
  const body = (await created.clone().json()) as Json;
  const id = await sessionIdOf(created, 'card-check create');
  assert.equal(body['firstCharge'], 'card_check', 'the create echoes the mode');
  const fullPrice = (await (
    await createSession(http, cardCheckBody('sp:cch-b', { firstCharge: 'now' }))
  ).json()) as Json;
  assert.equal(
    fullPrice['firstCharge'],
    'now',
    'a full-price create echoes now',
  );
  const otherMode = await createSession(
    http,
    cardCheckBody('sp:cch-a', { ...fixed, firstCharge: 'now' }),
    'cch-key',
  );
  assert.equal(otherMode.status, 409, 'the key cannot switch the mode (409)');
  const replay = (await (
    await createSession(http, cardCheckBody('sp:cch-a', fixed), 'cch-key')
  ).json()) as Json;
  assert.deepEqual(
    [replay['sessionId'], replay['firstCharge']],
    [id, 'card_check'],
    'a replay returns the same session and mode',
  );
  return id;
};

const readPayActivate = async (http: Http, id: string) => {
  const read = await publicRead(http, id);
  assert.deepEqual(
    [read['firstCharge'], read['closedReason'], read['methodLocked']],
    ['card_check', null, true],
    'the public read discloses the mode, no close reason, the locked method',
  );
  const paid = await pay(http, id, PaymentMethod.Card);
  assert.equal(paid.status, 200, '/pay → 200');
  const fields = paid.body['fields'] as Json;
  assert.deepEqual(
    [fields['amount'], fields['currency'], fields['paymentSystem']],
    [0, 'UAH', 'lookupCard'],
    'the verify form, although W4P_CARD_VERIFY_ENABLED is off',
  );
  await verifyCallback(http, id);
  assert.equal(await paymentsOf(http, 'sp:cch-a'), '1', 'activated');
  assert.equal(
    await eventsOf(http, 'sp:cch-a').then((e) => e.replace(/:[^,]+/g, '')),
    'payment_created,subscription_card_checked',
    'through the callback route and the queue',
  );
  assert.equal(
    (await publicRead(http, id))['status'],
    CheckoutSessionStatus.Completed,
    'the session reads Completed',
  );
};

const createAndActivate: Scenario = {
  name: 'card check (HTTP): admission gate, create echo + identity, public read, verify form, activation through the callback route',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-crm');
    await admissionOff(http);
    await withCardCheckApp(http, async (on) => {
      const id = await createEchoAndIdentity(on);
      await readPayActivate(on, id);
    });
  },
};

// ---------------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------------

export const close = (
  http: Http,
  id: string,
  secret: string | null = http.secret,
) =>
  postJson(
    `${http.baseUrl}/api/checkout-sessions/${id}/close`,
    {},
    secret === null ? {} : bearer(secret),
  );

const closeFirst = async (http: Http) => {
  const id = await sessionIdOf(
    await createSession(http, cardCheckBody('sp:ccc-a')),
    'create A',
  );
  const first = await close(http, id);
  const again = await close(http, id);
  assert.deepEqual(
    [first.status, await first.json(), again.status, await again.json()],
    [
      200,
      { status: 'closed', closedReason: 'superseded' },
      200,
      { status: 'closed', closedReason: 'superseded' },
    ],
    'close → 200, and 200 again',
  );
  await verifyCallback(http, id);
  assert.equal(
    await paymentsOf(http, 'sp:ccc-a'),
    '0',
    'a verify after close activates nothing',
  );
  assert.equal(
    await statusAndReason(http, id),
    `${String(CheckoutSessionStatus.Closed)}|superseded`,
    'still closed',
  );
};

const callbackFirst = async (http: Http) => {
  const id = await sessionIdOf(
    await createSession(http, cardCheckBody('sp:ccc-b')),
    'create B',
  );
  await verifyCallback(http, id);
  const res = await close(http, id);
  assert.equal(res.status, 409, 'a close after the verify activated → 409');
  assert.equal(await paymentsOf(http, 'sp:ccc-b'), '1', 'the payment stands');
};

const closeRefusals = async (http: Http) => {
  const fullPrice = await sessionIdOf(
    await createSession(
      http,
      cardCheckBody('sp:ccc-c', { firstCharge: 'now' }),
    ),
    'create full price',
  );
  const statuses = [
    (await close(http, fullPrice)).status,
    (await close(http, 'chk_unknown')).status,
    (await close(http, fullPrice, null)).status,
    (await close(http, fullPrice, 'not-a-token')).status,
  ];
  assert.deepEqual(
    statuses,
    [422, 404, 401, 401],
    'full price 422, unknown 404, no or bad token 401',
  );
  assert.equal(
    await statusAndReason(http, fullPrice),
    `${String(CheckoutSessionStatus.Created)}|`,
    'the full-price session is untouched',
  );
};

const closeScenario: Scenario = {
  name: 'card check (HTTP): close vs callback in both orders, and what close refuses',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-close');
    await withCardCheckApp(http, async (on) => {
      await closeFirst(on);
      await callbackFirst(on);
      await closeRefusals(on);
    });
  },
};

// ---------------------------------------------------------------------------------
// handover defer
// ---------------------------------------------------------------------------------

interface Seed {
  readonly contact: string;
  readonly next: Date;
  readonly firstCharge?: 'now' | 'card_check';
  readonly status?: PaymentStatus;
  readonly charged?: boolean;
}

/** A card-check payment (or a variant of one) whose first charge is due at `next`. */
export const seedPayment = (s: Seed) =>
  onDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const payment = yield* makePaymentRepo(sql).insert({
        externalUserId: s.contact,
        ...PLAN,
        method: PaymentMethod.Card,
        status: s.status ?? PaymentStatus.Active,
        recurring: true,
        currentPeriodStart: new Date(),
        currentPeriodEnd: s.next,
        nextPaymentDate: s.next,
        recurringTokenRef: 'tok_cc',
        firstFailureAt: null,
        retryAttempt: 0,
        firstCharge: s.firstCharge ?? 'card_check',
      });
      if (s.charged === true) {
        const charges = makeChargeRepo(sql);
        const incoming = yield* charges.upsertIncomingCharge({
          source: 'wayforpay_charge',
          idemKey: `w4p:seed-${payment.id}`,
          externalRef: `sub_${payment.id}_seed`,
          externalUserId: s.contact,
          amount: PLAN.amount,
          currency: PLAN.currency,
          status: 'succeeded',
          occurredAt: new Date(),
          payload: {},
        });
        yield* charges.insertPayment({
          incomingEventId: incoming,
          paymentId: payment.id,
          externalUserId: s.contact,
          amount: PLAN.amount,
          currency: PLAN.currency,
          source: 'wayforpay_charge',
          occurredAt: new Date(),
        });
        // A charge that credited a period records the payment's first money.
        yield* makePaymentRepo(sql).markFirstMoney(
          payment.id,
          `sub_${payment.id}_seed`,
        );
      }
      return payment;
    }),
  );

interface DeferCall {
  readonly body: Json;
  readonly secret?: string | null;
  readonly key?: string | null;
}

export const defer = (http: Http, paymentId: string, call: DeferCall) =>
  postJson(`${http.baseUrl}/api/payment/${paymentId}/defer`, call.body, {
    ...(call.secret === null ? {} : bearer(call.secret ?? http.secret)),
    ...(call.key === null
      ? {}
      : { 'idempotency-key': call.key ?? randomUUID() }),
  });

export const handover = (deferTo: Date): Json => ({
  reason: 'handover',
  deferTo: deferTo.toISOString(),
});

export const nextOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT (extract(epoch FROM "nextPaymentDate") * 1000)::bigint || '|' || (extract(epoch FROM "currentPeriodEnd") * 1000)::bigint || '|' || "deferRevision" FROM payments WHERE id = '${id}'`,
  );

/** One row of the shape table: a fresh payment, one call, its status and code. */
interface ShapeRow {
  readonly label: string;
  readonly seed: Omit<Seed, 'contact'>;
  readonly call: DeferCall;
  readonly status: number;
  /** The refusal code; absent on an answer that carries none (202, 401). */
  readonly code?: string;
}

const shapeRow = async (http: Http, row: ShapeRow) => {
  const payment = await seedPayment({
    contact: `sp:cch-${row.label}`,
    ...row.seed,
  });

  const res = await defer(http, payment.id, row.call);

  const body = (await res.json()) as Json;
  assert.deepEqual(
    [res.status, body['code']],
    [row.status, row.code],
    `${row.label} → ${String(row.status)} ${row.code ?? ''}`,
  );
  return { payment, body };
};

const CURRENT = () => new Date(Date.now() + 10 * DAY);

/** Auth and eligibility refusals, each on a fresh payment due at `next`. */
const refusalRows = (next: Date, oneDayOn: Json): readonly ShapeRow[] => [
  {
    label: 'notoken',
    seed: { next },
    call: { body: oneDayOn, secret: null },
    status: 401,
  },
  {
    label: 'badtoken',
    seed: { next },
    call: { body: oneDayOn, secret: 'nope' },
    status: 401,
  },
  {
    label: 'days',
    seed: { next },
    call: { body: { ...oneDayOn, days: 1 } },
    status: 422,
    code: 'invalid_request',
  },
  {
    label: 'nokey',
    seed: { next },
    call: { body: oneDayOn, key: null },
    status: 422,
    code: 'invalid_request',
  },
  {
    label: 'fullprice',
    seed: { next, firstCharge: 'now' },
    call: { body: oneDayOn },
    status: 422,
    code: 'not_card_check',
  },
  {
    label: 'charged',
    seed: { next, charged: true },
    call: { body: oneDayOn },
    status: 422,
    code: 'charged',
  },
];

const authAndShapeRefusals = async (http: Http) => {
  const next = CURRENT();
  const oneDayOn = handover(new Date(next.getTime() + DAY));
  const rows = refusalRows(next, oneDayOn);
  for (const row of rows) {
    await shapeRow(http, row);
  }
  const { body } = await shapeRow(http, {
    label: 'pastdue',
    seed: { next, status: PaymentStatus.PastDue },
    call: { body: oneDayOn },
    status: 422,
    code: 'not_active',
  });
  assert.equal(
    body['paymentStatus'],
    PaymentStatus.PastDue,
    'not_active names the status',
  );
};

const boundRows = async (http: Http) => {
  const next = CURRENT();
  const nextMs = next.getTime();
  const rows: readonly (readonly [string, number, number, string])[] = [
    ['equal', 0, 202, `${String(nextMs)}|${String(nextMs)}|0`],
    ['minus1', -1, 202, `${String(nextMs)}|${String(nextMs)}|0`],
    ['plus1', 1, 202, `${String(nextMs + 1)}|${String(nextMs + 1)}|1`],
    [
      'plus30d',
      30 * DAY,
      202,
      `${String(nextMs + 30 * DAY)}|${String(nextMs + 30 * DAY)}|1`,
    ],
    ['plus30d1', 30 * DAY + 1, 422, `${String(nextMs)}|${String(nextMs)}|0`],
  ];
  for (const [label, offset, status, row] of rows) {
    const { payment } = await shapeRow(http, {
      label,
      seed: { next },
      call: { body: handover(new Date(nextMs + offset)) },
      status,
      ...(status === 422 ? { code: 'out_of_bounds' } : {}),
    });
    assert.equal(await nextOf(http, payment.id), row, `${label}: the row`);
  }
};

const horizonRow = (http: Http) =>
  shapeRow(http, {
    label: 'horizon',
    seed: { next: new Date(Date.now() + 40 * DAY) },
    call: { body: handover(new Date(Date.now() + 62 * DAY + 60_000)) },
    status: 422,
    code: 'out_of_bounds',
  });

const handoverShape: Scenario = {
  name: 'handover defer (HTTP): service-token shape table — auth, eligibility, forward-only and bounds',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-defer');
    await authAndShapeRefusals(http);
    await boundRows(http);
    await horizonRow(http);
  },
};

// ---------------------------------------------------------------------------------
// operator defer, revisions, ledger
// ---------------------------------------------------------------------------------

export const operatorCookie = async (http: Http): Promise<string> => {
  await postJson(
    `${http.baseUrl}/auth/operators`,
    { login: 'cch-op', password: 'cch-pass', role: 1 },
    bearer(ADMIN_TOKEN),
  );
  const login = await http.bff(
    new Request(`${http.baseUrl}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'cch-op', password: 'cch-pass' }),
    }),
  );
  const match = /bss=([^;]+)/.exec(login.headers.get('set-cookie') ?? '');
  return `bss=${match?.[1] ?? ''}`;
};

export const operatorDefer = (
  http: Http,
  cookie: string,
  id: string,
  body: Json,
) =>
  http.bff(
    new Request(`${http.baseUrl}/api/payment/${id}/defer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );

export const auditRevisions = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT string_agg((detail->>'revision') || ':' || coalesce(detail->>'reason', '-'), ',' ORDER BY "occurredAt", id) FROM audit_log WHERE "targetId" = '${id}' AND action = 'defer_payment'`,
  );

/** A worker pass that also runs the `payment_defer` notify, as the worker does. */
export const drainWithDefers = () =>
  onDb(
    Effect.gen(function* () {
      yield* registerHandlers;
      const registry = yield* TaskRegistry;
      yield* registry.register(
        PAYMENT_DEFER,
        deferNotify((yield* Outbox).publish),
      );
      yield* runFor(2);
    }),
  );

export const deferredEvents = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT string_agg((payload->>'revision') || ':' || coalesce(payload->>'reason', '-'), ',' ORDER BY (payload->>'revision')::int) FROM domain_events WHERE "aggregateId" = '${id}' AND name = 'payment_deferred'`,
  );

const operatorThenHandover: Scenario = {
  name: 'defer (HTTP): the operator defer is unchanged; operator then handover take revisions 1 and 2 in audit and notification; the service token cannot send {days}',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-rev');
    const cookie = await operatorCookie(http);
    const next = CURRENT();
    const payment = await seedPayment({ contact: 'sp:cch-rev', next });
    const asService = await defer(http, payment.id, { body: { days: 2 } });
    assert.equal(asService.status, 401, 'the service token on {days} → 401');
    const op = await operatorDefer(http, cookie, payment.id, { days: 2 });
    const opBody = (await op.json()) as Json;
    assert.deepEqual(
      [op.status, opBody['status'], opBody['newPeriodEnd'], opBody['revision']],
      [202, 'deferred', new Date(next.getTime() + 2 * DAY).toISOString(), 1],
      'operator {days}: relative, revision 1',
    );
    const ho = await defer(http, payment.id, {
      body: handover(new Date(next.getTime() + 3 * DAY)),
    });
    assert.deepEqual(
      [ho.status, ((await ho.json()) as Json)['revision']],
      [202, 2],
      'handover: revision 2',
    );
    await drainWithDefers();
    assert.equal(
      await auditRevisions(http, payment.id),
      '1:-,2:handover',
      'audit',
    );
    assert.equal(
      await deferredEvents(http, payment.id),
      '1:-,2:handover',
      'notifications',
    );
  },
};

const replayAfterCancel = async (http: Http, next: Date) => {
  // Commit, lose the answer, the payment is cancelled, the same key comes back.
  const lost = await seedPayment({ contact: 'sp:cch-lost', next });
  const to = handover(new Date(next.getTime() + DAY));
  const first = await (
    await defer(http, lost.id, { body: to, key: 'k-lost' })
  ).json();
  await http.query(
    `UPDATE payments SET status = ${String(PaymentStatus.Cancelled)} WHERE id = '${lost.id}'`,
  );

  const again = await defer(http, lost.id, { body: to, key: 'k-lost' });

  assert.deepEqual(
    [again.status, await again.json()],
    [202, first],
    'the saved deferred answer, revision included',
  );
  await drainWithDefers();
  assert.equal(
    await deferredEvents(http, lost.id),
    '1:handover',
    'one payment_deferred',
  );
};

const unchangedKeepsRevision = async (http: Http, next: Date) => {
  const same = await seedPayment({ contact: 'sp:cch-same', next });

  const unchanged = await defer(http, same.id, { body: handover(next) });

  assert.deepEqual(
    await unchanged.json(),
    { status: 'unchanged', newPeriodEnd: next.toISOString(), revision: 0 },
    'unchanged answers the current date and revision',
  );
  await drainWithDefers();
  assert.equal(await deferredEvents(http, same.id), '', 'no event');
};

const replayAfterRestart = async (http: Http, next: Date) => {
  const restarted = await seedPayment({ contact: 'sp:cch-restart', next });
  const to = handover(new Date(next.getTime() + DAY));
  const before = await (
    await defer(http, restarted.id, { body: to, key: 'k-restart' })
  ).json();
  const app = await buildApp();
  try {
    const other = await onApp(
      http,
      await app.listen({ host: '127.0.0.1', port: 0 }),
    );

    const after = await defer(other, restarted.id, {
      body: to,
      key: 'k-restart',
    });

    assert.deepEqual(await after.json(), before, 'the other instance replays');
  } finally {
    await app.close();
  }
};

const concurrentIdentical = async (http: Http, next: Date) => {
  const raced = await seedPayment({ contact: 'sp:cch-race', next });
  const to = handover(new Date(next.getTime() + DAY));

  const answers = await Promise.all([
    defer(http, raced.id, { body: to, key: 'k-race' }).then((r) => r.json()),
    defer(http, raced.id, { body: to, key: 'k-race' }).then((r) => r.json()),
  ]);

  assert.deepEqual(answers[0], answers[1], 'both get the same answer');
  assert.equal(
    (await nextOf(http, raced.id)).split('|')[2],
    '1',
    'deferred once',
  );
};

const ledgerScenario: Scenario = {
  name: 'handover defer (HTTP): replay after a cancel, unchanged keeps the revision, restart replay, concurrent identical requests',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-ledger');
    const next = CURRENT();
    await replayAfterCancel(http, next);
    await unchangedKeepsRevision(http, next);
    await replayAfterRestart(http, next);
    await concurrentIdentical(http, next);
  },
};

// ---------------------------------------------------------------------------------
// regressions: the full-price and card-change paths
// ---------------------------------------------------------------------------------

const fullPriceMigration: Scenario = {
  name: 'regression (HTTP): a full-price migration still pays now — recurring_payment_succeeded + subscription_migrated, 5000 USD, startsAt + 28 d',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-full');
    const startsAt = new Date(Date.now() + 10 * DAY);
    const id = await sessionIdOf(
      await createSession(
        http,
        cardCheckBody('sp:cch-full', {
          firstCharge: undefined,
          startsAt: startsAt.toISOString(),
        }),
      ),
      'full-price create',
    );
    const order = cardOrderOf(await pay(http, id, PaymentMethod.Card), 'pay');
    assert.equal(order.amount, 50, 'a priced Purchase of the plan');
    await w4pCallback(http, 'Approved', { ...order, currency: 'USD' });
    assert.equal(
      (await eventsOf(http, 'sp:cch-full')).replace(/:[^,]+/g, ''),
      'payment_created,recurring_payment_succeeded,subscription_migrated',
      'the full-price events, unchanged',
    );
    assert.equal(
      await scalar(
        http,
        `SELECT amount || '|' || currency || '|' || "firstCharge" || '|' || (extract(epoch FROM "currentPeriodEnd") * 1000)::bigint FROM payments WHERE "externalUserId" = 'sp:cch-full'`,
      ),
      `5000|1|now|${String(startsAt.getTime() + 28 * DAY)}`,
      '5000 USD, anchored at startsAt + 28 d',
    );
  },
};

const seedCardSub = (contact: string) =>
  onDb(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      makePaymentRepo(sql).insert({
        externalUserId: contact,
        ...PLAN,
        method: PaymentMethod.Card,
        status: PaymentStatus.Active,
        recurring: true,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
        nextPaymentDate: new Date(Date.now() + 20 * DAY),
        recurringTokenRef: 'tok_old',
        firstFailureAt: null,
        retryAttempt: 0,
      }),
    ),
  );

const cardChange = async (http: Http, contact: string): Promise<string> =>
  sessionIdOf(
    await postJson(
      `${http.baseUrl}/api/payment/card-change`,
      { externalUserId: contact },
      bearer(http.secret),
    ),
    `card change ${contact}`,
  );

const datesOf = (http: Http, id: string) =>
  scalar(
    http,
    `SELECT "currentPeriodEnd" || '|' || "nextPaymentDate" FROM payments WHERE id = '${id}'`,
  );

const cardChangeVerifyOff: Scenario = {
  name: 'regression (HTTP): card change with verify off is a Purchase; the token is rewritten, card_change_succeeded, dates unchanged',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-change');
    const sub = await seedCardSub('sp:cch-change');
    const dates = await datesOf(http, sub.id);
    const id = await cardChange(http, 'sp:cch-change');
    const paid = await pay(http, id, PaymentMethod.Card);
    assert.equal(
      (paid.body['fields'] as Json)['paymentSystem'],
      undefined,
      'a Purchase, not a verify',
    );
    await w4pCallback(http, 'Approved', { ref: id, amount: 0 });
    assert.equal(
      await scalar(
        http,
        `SELECT "recurringTokenRef" FROM payments WHERE id = '${sub.id}'`,
      ),
      'tok_w4p',
      'the token is rewritten',
    );
    assert.equal(await datesOf(http, sub.id), dates, 'dates unchanged');
    assert.equal(
      (await eventsOf(http, 'sp:cch-change')).replace(/:[^,]+/g, ''),
      'card_change_succeeded',
      'card_change_succeeded only',
    );
  },
};

const cardChangeVerifyOn: Scenario = {
  name: 'regression (HTTP): card change with verify on hands out the verify form; its matcher is unchanged',
  run: async ({ baseUrl, query }) => {
    const http = await httpContext(baseUrl, query, 'cch-change-on');
    const sub = await seedCardSub('sp:cch-change-on');
    await withCardCheckApp(
      http,
      async (on) => {
        const id = await cardChange(on, 'sp:cch-change-on');
        const paid = await pay(on, id, PaymentMethod.Card);
        assert.equal(
          (paid.body['fields'] as Json)['paymentSystem'],
          'lookupCard',
          'the verify form',
        );
        await w4pCallback(on, 'Approved', { ref: id, amount: 0 });
        assert.equal(
          await scalar(
            on,
            `SELECT "recurringTokenRef" FROM payments WHERE id = '${sub.id}'`,
          ),
          'tok_w4p',
          'the card-change matcher still settles it',
        );
      },
      { W4P_CARD_VERIFY_ENABLED: 'true' },
    );
  },
};

export const cardCheckHttpScenarios: readonly Scenario[] = [
  createAndActivate,
  closeScenario,
  handoverShape,
  operatorThenHandover,
  ledgerScenario,
  fullPriceMigration,
  cardChangeVerifyOff,
  cardChangeVerifyOn,
];
