import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
} from '@billing-service/shared';
import { Clock, Effect, Exit, Option } from 'effect';

import {
  ledgerClaimAdvance,
  scheduleTick,
} from '@/modules/billing/scheduler.js';
import type { Charge } from '@/modules/charge/contracts.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  asPayload,
  DAY,
  drain,
  type EffectE2eContext,
  type EffectScenario,
  expectRows,
  failOncePublishing,
  HOUR,
  registerHandlers,
  seedSub,
  settlementHandler,
  withWorker,
  type WorkerContext,
} from '@/modules/charge/test/e2e-harness.js';
import {
  closeOpenCardCheck,
  makeCheckoutRepo,
} from '@/modules/checkout/data-access.js';
import { prolongSession } from '@/modules/checkout/domain.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { deferToDate, makePaymentRepo } from '@/modules/payment/data-access.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';

/**
 * Card-check dispatch on a real Postgres (plan §6, billing integration): the settlement
 * handler exactly as the worker builds it, fed the callback a WayForPay verify produces,
 * and the database read back after each step.
 */

const PLAN_AMOUNT = 5000;
const USD = 1;

const cardCheckSession = (
  id: string,
  externalUserId: string,
  startsAt: Date,
  extra: Partial<NewCheckoutSession> = {},
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: PLAN_AMOUNT,
  currency: USD,
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
  metadata: { attemptId: id },
  startsAt,
  payableUntil: null,
  lockMethod: true,
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(startsAt.getTime() - DAY),
  firstCharge: 'card_check',
  ...extra,
});

const seedSession = (session: NewCheckoutSession) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    makeCheckoutRepo(sql).insert(session),
  );

/** The serviceUrl callback of a WayForPay verify, through the real normaliser. */
const verifyCallback = (
  ref: string,
  raw: Record<string, unknown> = {},
): Charge =>
  normalizeCallback({
    orderReference: ref,
    transactionStatus: 'WaitingAuthComplete',
    reasonCode: 1100,
    amount: '0',
    currency: 'UAH',
    recToken: 'tok_cc',
    createdDate: String(Math.floor(Date.now() / 1000)),
    ...raw,
  });

/** Run one effect on a fresh worker runtime and hand back its result. */
const onWorker = async <A, E>(
  config: EffectE2eContext['config'],
  effect: Effect.Effect<A, E, WorkerContext>,
): Promise<A> => {
  let out: A | undefined;
  await withWorker(config, async (run) => {
    out = await run(effect);
  });
  return out as A;
};

const settle = (charge: Charge) =>
  Effect.flatMap(settlementHandler(), (handle) => handle(asPayload(charge)));

const inDays = (days: number): Date => new Date(Date.now() + days * DAY);

const eventsOf = (contact: string) =>
  `SELECT coalesce(string_agg(name, ',' ORDER BY "createdAt", ctid), '') FROM domain_events WHERE "externalUserId" = '${contact}'`;

const sessionStatus = (id: string) =>
  `SELECT status || '|' || coalesce("closedReason", '') FROM checkout_sessions WHERE id = '${id}'`;

const paymentsOf = (contact: string) =>
  `SELECT count(*) FROM payments WHERE "externalUserId" = '${contact}'`;

const matchResultsOf = (ref: string) =>
  `SELECT string_agg("matchResult", ',' ORDER BY "receivedAt", id) FROM charges WHERE "externalRef" = '${ref}'`;

const ms = (sql: string) =>
  `SELECT (extract(epoch FROM (${sql})) * 1000)::bigint`;

const open = String(CheckoutSessionStatus.Created);
const completed = String(CheckoutSessionStatus.Completed);
const closed = String(CheckoutSessionStatus.Closed);

// ---------------------------------------------------------------------------------
// verified
// ---------------------------------------------------------------------------------

const VERIFIED = 'sp:cc-verified';
const VERIFIED_ID = 'chk_cc-verified';

const verified: EffectScenario = {
  name: 'card check: a verified card creates the payment at the plan terms, first charge at startsAt, no fixation',
  run: async ({ config, query }) => {
    const startsAt = inDays(10);
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(cardCheckSession(VERIFIED_ID, VERIFIED, startsAt));
          yield* settle(verifyCallback(VERIFIED_ID));
        }),
      ),
    );
    const payment = `SELECT %s FROM payments WHERE "externalUserId" = '${VERIFIED}'`;
    await expectRows(query, [
      [
        payment.replace(
          '%s',
          `amount || '|' || currency || '|' || "recurringTokenRef" || '|' || status || '|' || "firstCharge" || '|' || period`,
        ),
        `${String(PLAN_AMOUNT)}|${String(USD)}|tok_cc|0|card_check|P4W`,
        'the plan amount (5000 USD), the verify token, Active, card_check',
      ],
      [
        ms(payment.replace('%s', '"nextPaymentDate"')),
        String(startsAt.getTime()),
        'the first charge falls on startsAt',
      ],
      [
        ms(payment.replace('%s', '"currentPeriodEnd"')),
        String(startsAt.getTime()),
        'no period was credited: the anchor is startsAt itself',
      ],
      [
        eventsOf(VERIFIED),
        'payment_created,subscription_card_checked',
        'exactly payment_created and subscription_card_checked',
      ],
      [
        `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${VERIFIED}'`,
        '0',
        'no fixation: no money moved',
      ],
      [sessionStatus(VERIFIED_ID), `${completed}|`, 'the session completed'],
      [matchResultsOf(VERIFIED_ID), 'matched', 'the charge closed as matched'],
      [
        `SELECT payload->>'amount' || '|' || (payload->>'currency') || '|' || (payload->>'firstCharge') FROM domain_events WHERE name = 'payment_created' AND "externalUserId" = '${VERIFIED}'`,
        `${String(PLAN_AMOUNT)}|${String(USD)}|card_check`,
        'payment_created carries the plan amount and currency and the mode',
      ],
      [
        `SELECT payload->>'amount' || '|' || (payload->>'nextAmount') || '|' || (payload->>'currency') || '|' || coalesce(payload->>'periodStart', 'null') || '|' || (payload->>'checkoutSessionId') FROM domain_events WHERE name = 'subscription_card_checked'`,
        `0|${String(PLAN_AMOUNT)}|${String(USD)}|null|${VERIFIED_ID}`,
        'subscription_card_checked: nothing charged, the plan price next, no window',
      ],
    ]);
  },
};

const DUP = 'sp:cc-dup';
const DUP_ID = 'chk_cc-dup';

const duplicate: EffectScenario = {
  name: 'card check: a duplicate callback writes nothing more',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(cardCheckSession(DUP_ID, DUP, inDays(10)));
          yield* settle(verifyCallback(DUP_ID));
          yield* settle(verifyCallback(DUP_ID));
        }),
      ),
    );
    await expectRows(query, [
      [paymentsOf(DUP), '1', 'one payment'],
      [
        eventsOf(DUP),
        'payment_created,subscription_card_checked',
        'one pair of events',
      ],
    ]);
  },
};

const RACE = 'sp:cc-race';
const RACE_ID = 'chk_cc-race';

const concurrent: EffectScenario = {
  name: 'card check: two verify callbacks settling at once activate once',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(cardCheckSession(RACE_ID, RACE, inDays(10)));
          const first = verifyCallback(RACE_ID);
          // Another copy of the same verify under its own key (as a resend could carry).
          const second = { ...first, idemKey: `${first.idemKey}|copy` };
          yield* Effect.all([settle(first), settle(second)], {
            concurrency: 2,
          });
        }),
      ),
    );
    await expectRows(query, [
      [paymentsOf(RACE), '1', 'one payment'],
      [
        eventsOf(RACE),
        'payment_created,subscription_card_checked',
        'one activation',
      ],
      [matchResultsOf(RACE_ID), 'matched,matched', 'both charges closed'],
    ]);
  },
};

const FAULT = 'sp:cc-fault';
const FAULT_ID = 'chk_cc-fault';

const midApplyFailure: EffectScenario = {
  name: 'card check: a failure mid-apply leaves the session open, the raw receipt kept, nothing written; the retry activates',
  run: async ({ config, query }) => {
    const charge = verifyCallback(FAULT_ID);
    const failed = await onWorker(
      config,
      Effect.gen(function* () {
        yield* seedSession(cardCheckSession(FAULT_ID, FAULT, inDays(10)));
        const outbox = yield* Outbox;
        const handle = yield* settlementHandler({
          publish: failOncePublishing(
            outbox.publish,
            'subscription_card_checked',
          ),
        });
        return yield* Effect.exit(handle(asPayload(charge)));
      }),
    );
    assert.ok(Exit.isFailure(failed), 'the injected fault failed the attempt');
    await expectRows(query, [
      [sessionStatus(FAULT_ID), `${open}|`, 'the session is still open'],
      [
        `SELECT count(*) FROM charges WHERE "externalRef" = '${FAULT_ID}'`,
        '1',
        'the raw receipt survived',
      ],
      [paymentsOf(FAULT), '0', 'no payment'],
      [eventsOf(FAULT), '', 'no event'],
    ]);
    await withWorker(config, (run) => run(settle(charge)));
    await expectRows(query, [
      [paymentsOf(FAULT), '1', 'the retry activated'],
      [
        eventsOf(FAULT),
        'payment_created,subscription_card_checked',
        'its events',
      ],
    ]);
  },
};

// ---------------------------------------------------------------------------------
// the other outcomes
// ---------------------------------------------------------------------------------

const LATE = 'sp:cc-late';
const LATE_ID = 'chk_cc-late';

const late: EffectScenario = {
  name: 'card check: a verify within 24 h of startsAt closes the session late, no payment',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(
            cardCheckSession(LATE_ID, LATE, new Date(Date.now() + 23 * HOUR)),
          );
          yield* settle(verifyCallback(LATE_ID));
        }),
      ),
    );
    await expectRows(query, [
      [sessionStatus(LATE_ID), `${closed}|late`, 'closed as late'],
      [paymentsOf(LATE), '0', 'no payment'],
      [eventsOf(LATE), 'card_check_failed', 'card_check_failed only'],
      [
        `SELECT payload->>'reason' FROM domain_events WHERE "externalUserId" = '${LATE}'`,
        'late',
        'reason late',
      ],
    ]);
  },
};

const LIVE = 'sp:cc-live';
const LIVE_ID = 'chk_cc-live';

const onLive: EffectScenario = {
  name: 'card check: a contact with a live subscription gets on_live, and the live row is not touched',
  run: async ({ config, query }) => {
    const rowSql = `SELECT p::text FROM payments p WHERE "externalUserId" = '${LIVE}'`;
    await onWorker(
      config,
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        seedSub(makePaymentRepo(sql), { externalUserId: LIVE, end: inDays(5) }),
      ),
    );
    const before = (await query(rowSql)).trim();
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(cardCheckSession(LIVE_ID, LIVE, inDays(10)));
          yield* settle(verifyCallback(LIVE_ID));
        }),
      ),
    );
    await expectRows(query, [
      [rowSql, before, 'the live row is byte-identical'],
      [sessionStatus(LIVE_ID), `${closed}|on_live`, 'closed as on_live'],
      [eventsOf(LIVE), 'card_check_failed', 'card_check_failed only'],
      [
        `SELECT payload->>'reason' FROM domain_events WHERE "externalUserId" = '${LIVE}'`,
        'on_live',
        'reason on_live',
      ],
    ]);
  },
};

const CLOSED = 'sp:cc-closed';
const CLOSED_ID = 'chk_cc-closed';

const closedSession: EffectScenario = {
  name: 'card check: a verify on a closed session writes and emits nothing',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedSession(cardCheckSession(CLOSED_ID, CLOSED, inDays(10)));
          yield* closeOpenCardCheck(sql)(CLOSED_ID, 'superseded');
          yield* settle(verifyCallback(CLOSED_ID));
        }),
      ),
    );
    await expectRows(query, [
      [sessionStatus(CLOSED_ID), `${closed}|superseded`, 'still superseded'],
      [paymentsOf(CLOSED), '0', 'no payment'],
      [eventsOf(CLOSED), '', 'no event'],
      [matchResultsOf(CLOSED_ID), 'matched', 'the charge closed as matched'],
    ]);
  },
};

const DECLINED = 'sp:cc-declined';
const DECLINED_ID = 'chk_cc-declined';

const declined: EffectScenario = {
  name: 'card check: a decline is reported and keeps the session open; a later verify still activates',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(
            cardCheckSession(DECLINED_ID, DECLINED, inDays(10)),
          );
          yield* settle(
            verifyCallback(DECLINED_ID, {
              transactionStatus: 'Declined',
              reasonCode: 1101,
              recToken: '',
            }),
          );
        }),
      ),
    );
    await expectRows(query, [
      [sessionStatus(DECLINED_ID), `${open}|`, 'the session stays open'],
      [paymentsOf(DECLINED), '0', 'no payment'],
      [eventsOf(DECLINED), 'card_check_failed', 'card_check_failed'],
      [
        `SELECT payload->>'reason' FROM domain_events WHERE "externalUserId" = '${DECLINED}'`,
        'declined',
        'reason declined',
      ],
    ]);
    await withWorker(config, (run) => run(settle(verifyCallback(DECLINED_ID))));
    await expectRows(query, [
      [paymentsOf(DECLINED), '1', 'the retry activated'],
    ]);
  },
};

const TERMINAL = 'sp:cc-terminal';
const TERMINAL_ID = 'chk_cc-terminal';

const terminal: EffectScenario = {
  name: 'card check: a callback after activation is a terminal update, nothing written',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(
            cardCheckSession(TERMINAL_ID, TERMINAL, inDays(10)),
          );
          yield* settle(verifyCallback(TERMINAL_ID));
          yield* settle(
            verifyCallback(TERMINAL_ID, { transactionStatus: 'Expired' }),
          );
        }),
      ),
    );
    await expectRows(query, [
      [sessionStatus(TERMINAL_ID), `${completed}|`, 'still completed'],
      [
        eventsOf(TERMINAL),
        'payment_created,subscription_card_checked',
        'no event for the later callback',
      ],
      [matchResultsOf(TERMINAL_ID), 'matched,matched', 'both closed'],
    ]);
  },
};

const ANOMALY = 'sp:cc-anomaly';
const ANOMALY_ID = 'chk_cc-anomaly';

const anomalous: EffectScenario = {
  name: 'card check: an Approved charge on a card-check session is an anomaly, never a payment',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedSession(cardCheckSession(ANOMALY_ID, ANOMALY, inDays(10)));
          yield* settle(
            verifyCallback(ANOMALY_ID, {
              transactionStatus: 'Approved',
              amount: '50.00',
              currency: 'USD',
            }),
          );
        }),
      ),
    );
    await expectRows(query, [
      [sessionStatus(ANOMALY_ID), `${open}|`, 'the session stays open'],
      [paymentsOf(ANOMALY), '0', 'no payment'],
      [eventsOf(ANOMALY), 'card_check_anomaly', 'card_check_anomaly only'],
      [
        `SELECT (payload->>'status') || '|' || (payload->>'reasonCode') || '|' || (payload->>'tokenPresent') FROM domain_events WHERE "externalUserId" = '${ANOMALY}'`,
        'Approved|1100|true',
        'the raw status, code and token presence',
      ],
      [
        `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${ANOMALY}'`,
        '0',
        'no fixation',
      ],
    ]);
  },
};

// ---------------------------------------------------------------------------------
// the first money success, and the scheduler on the deferred date
// ---------------------------------------------------------------------------------

const realClock = Clock.make();

/** A clock frozen at `millis`; sleeping still waits in real time. */
const clockAt = (millis: number): Clock.Clock => ({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  unsafeCurrentTimeMillis: () => millis,
  currentTimeMillis: Effect.succeed(millis),
  unsafeCurrentTimeNanos: () => BigInt(millis) * BigInt(1_000_000),
  currentTimeNanos: Effect.succeed(BigInt(millis) * BigInt(1_000_000)),
  sleep: (duration) => realClock.sleep(duration),
});

/** One scheduler tick at `atMillis` with an approving WayForPay client that records the
 * orders it was asked to charge. */
const tickAt = (atMillis: number, charged: string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tick = scheduleTick(
      {
        subs: makePaymentRepo(sql),
        client: {
          charge: (request) =>
            Effect.sync(() => {
              charged.push(request.orderReference);
              return {
                transactionStatus: 'Approved',
                createdDate: String(Math.floor(atMillis / 1000)),
              };
            }),
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
    yield* Effect.withClock(tick, clockAt(atMillis));
    yield* drain;
  });

/** Activate a card check for `contact` and return its payment. */
const activated = (contact: string, sessionId: string, startsAt: Date) =>
  Effect.gen(function* () {
    yield* registerHandlers;
    yield* seedSession(cardCheckSession(sessionId, contact, startsAt));
    yield* settle(verifyCallback(sessionId));
    const sql = yield* SqlClient.SqlClient;
    const found =
      yield* makePaymentRepo(sql).findActiveRecurringByExternalUser(contact);
    return Option.getOrThrow(found);
  });

const markerOf = (contact: string) =>
  `SELECT coalesce(string_agg(coalesce(payload->>'cardCheckFirstCharge', '-'), ',' ORDER BY "createdAt", ctid), '') FROM domain_events WHERE "externalUserId" = '${contact}' AND name = 'recurring_payment_succeeded'`;

const FIRST = 'sp:cc-first';

const firstScheduled: EffectScenario = {
  name: 'card check: the first scheduled charge carries cardCheckFirstCharge, the second does not',
  run: async ({ config, query }: EffectE2eContext) => {
    const startsAt = inDays(10);
    const charged: string[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* activated(FIRST, 'chk_cc-first', startsAt);
          yield* tickAt(startsAt.getTime(), charged);
          yield* tickAt(startsAt.getTime() + 28 * DAY, charged);
        }),
      ),
    );
    assert.equal(charged.length, 2, 'two scheduled charges');
    await expectRows(query, [
      [markerOf(FIRST), 'true,-', 'only the first success is marked'],
      [
        ms(
          `SELECT "currentPeriodEnd" FROM payments WHERE "externalUserId" = '${FIRST}'`,
        ),
        String(startsAt.getTime() + 56 * DAY),
        'two P4W periods from startsAt',
      ],
    ]);
  },
};

const PROLONG = 'sp:cc-prolong';

const firstByProlong: EffectScenario = {
  name: 'card check: a /prolong paid before the first scheduled charge is the marked first money',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const sub: Payment = yield* activated(
            PROLONG,
            'chk_cc-prolong',
            inDays(10),
          );
          const sql = yield* SqlClient.SqlClient;
          yield* makeCheckoutRepo(sql).insert(
            prolongSession(sub, 'chk_cc-prolong-link', inDays(1), null),
          );
          yield* settle(
            normalizeCallback({
              orderReference: 'chk_cc-prolong-link',
              amount: '50.00',
              currency: 'USD',
              transactionStatus: 'Approved',
              recToken: 'tok_cc',
              createdDate: String(Math.floor(Date.now() / 1000)),
            }),
          );
        }),
      ),
    );
    await expectRows(query, [
      [markerOf(PROLONG), 'true', 'the prolong success is marked'],
    ]);
  },
};

const DEFERRED = 'sp:cc-deferred';

const chargesOnDeferredDate: EffectScenario = {
  name: 'card check: after a handover defer the scheduler charges on the deferred date, not before',
  run: async ({ config, query }) => {
    const startsAt = inDays(10);
    const deferTo = new Date(startsAt.getTime() + 3 * DAY);
    const charged: string[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const sub = yield* activated(DEFERRED, 'chk_cc-deferred', startsAt);
          yield* deferToDate(yield* SqlClient.SqlClient)(sub.id, deferTo);
          yield* tickAt(startsAt.getTime(), charged);
          yield* tickAt(deferTo.getTime() - 1, charged);
        }),
      ),
    );
    assert.deepEqual(charged, [], 'nothing charged before the deferred date');
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* registerHandlers;
          yield* tickAt(deferTo.getTime(), charged);
        }),
      ),
    );
    assert.equal(charged.length, 1, 'charged once, on the deferred date');
    await expectRows(query, [
      [
        ms(
          `SELECT "currentPeriodEnd" FROM payments WHERE "externalUserId" = '${DEFERRED}'`,
        ),
        String(deferTo.getTime() + 28 * DAY),
        'the first period runs from the deferred date',
      ],
      [markerOf(DEFERRED), 'true', 'and it is the marked first money'],
    ]);
  },
};

export const cardCheckScenarios: readonly EffectScenario[] = [
  verified,
  duplicate,
  concurrent,
  midApplyFailure,
  late,
  onLive,
  closedSession,
  declined,
  terminal,
  anomalous,
  firstScheduled,
  firstByProlong,
  chargesOnDeferredDate,
];
