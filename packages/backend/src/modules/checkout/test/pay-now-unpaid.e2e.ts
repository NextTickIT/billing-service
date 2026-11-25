import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  type NewCheckoutSession,
  PaymentMethod,
} from '@billing-service/shared';
import { type Clock, Context, Effect, Logger } from 'effect';

import { ledgerApproval } from '@/modules/billing/scheduler.js';
import type { Charge, ChargeApplier } from '@/modules/charge/contracts.js';
import {
  asPayload,
  DAY,
  type EffectScenario,
  expectRows,
  settlementHandler,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { makeCheckoutApplier } from '@/modules/checkout/domain.js';
import {
  PAY_NOW_UNPAID_AFTER_SECONDS,
  PAY_NOW_UNPAID_LOOKBACK_SECONDS,
  sweepUnpaidPayNow,
  UNPAID_BATCH,
  type UnpaidCursor,
} from '@/modules/checkout/pay-now-unpaid.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';
import type { W4pCheckStatusResponse } from '@/modules/wayforpay/contracts.js';
import {
  W4pApiError,
  W4pOrderNotFoundError,
  W4pTransportError,
} from '@/modules/wayforpay/errors.js';

/**
 * The unpaid pay-now sweep on a real Postgres (support case @nameBigBoss, 2026-11-25): an
 * open pay-now migration session whose `payableUntil` lapsed and whose order WayForPay
 * refused is closed `unpaid`; money that arrives for it afterwards is quarantined, never
 * booked. CHECK_STATUS is a canned fake keyed by order reference, recording which orders
 * it was asked about.
 */

const MINUTE = 60 * 1000;
const SESSION_AMOUNT_MINOR = 5000;
const SESSION_AMOUNT_MAJOR = '50';
const USD = 1;

const payNowSession = (
  id: string,
  externalUserId: string,
): NewCheckoutSession => ({
  id,
  externalUserId,
  amount: SESSION_AMOUNT_MINOR,
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
  startsAt: new Date(Date.now() + 30 * DAY),
  payableUntil: null,
  lockMethod: true,
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(Date.now() + 29 * DAY),
  firstCharge: 'now',
});

interface Seed {
  readonly firstCharge?: 'now' | 'card_check';
  /** Minutes since `payableUntil`; null leaves it unset. */
  readonly lapsedMinutesAgo?: number | null;
  /** An exact `payableUntil`, over `lapsedMinutesAgo`. */
  readonly payableUntil?: Date;
  readonly sent?: boolean;
  readonly withOptions?: boolean;
}

/** Seed an open (Pending) session pressed and sent to WayForPay, whose `payableUntil`
 * lapsed `lapsedMinutesAgo` ago. */
const pending = (id: string, contact: string, seed: Seed = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* makeCheckoutRepo(sql).insert({
      ...payNowSession(id, contact),
      firstCharge: seed.firstCharge ?? 'now',
    });
    const lapsed =
      seed.lapsedMinutesAgo === undefined ? 20 : seed.lapsedMinutesAgo;
    const payableUntil =
      seed.payableUntil ??
      (lapsed === null ? null : new Date(Date.now() - lapsed * MINUTE));
    const sentAt =
      seed.sent === false ? null : new Date(Date.now() - 2 * 60 * MINUTE);
    const options = seed.withOptions === true ? '[{"amount":5000}]' : null;
    yield* sql`
      UPDATE checkout_sessions
      SET status = 1, "claimedAt" = ${sentAt}, "firstSentToProviderAt" = ${sentAt},
          "payableUntil" = ${payableUntil}, options = ${options}::jsonb
      WHERE id = ${id}
    `;
  });

type Answer =
  | { readonly kind: 'status'; readonly response: W4pCheckStatusResponse }
  | { readonly kind: 'api_error'; readonly error: W4pApiError }
  | { readonly kind: 'transport_error' }
  | { readonly kind: 'hang' }
  | { readonly kind: 'not_found' };

/** One answer for every ask, or one per ask in turn (the last repeats). */
type Answers = Answer | readonly Answer[];

const answerAt = (answers: Answers | undefined, ask: number): Answer => {
  if (answers === undefined) return { kind: 'not_found' };
  if ('kind' in answers) return answers;
  return answers[Math.min(ask, answers.length - 1)] ?? { kind: 'not_found' };
};

const unixMinutesAgo = (minutes: number): number =>
  Math.floor((Date.now() - minutes * MINUTE) / 1000);

/** The live answer for @nameBigBoss's order: refused with 1124. */
const declined: Answer = {
  kind: 'api_error',
  error: new W4pApiError({
    endpoint: 'CHECK_STATUS',
    reasonCode: 1124,
    reason: 'Cardholder session expired',
    transactionStatus: 'Declined',
    processingDate: unixMinutesAgo(180),
  }),
};

/** A bank confirmation that started `minutesAgo` and was never answered. */
const otpWaitSince = (minutesAgo: number): Answer => ({
  kind: 'api_error',
  error: new W4pApiError({
    endpoint: 'CHECK_STATUS',
    reasonCode: 5110,
    reason: 'Ok',
    transactionStatus: 'WaitingOtpConfirm',
    processingDate: unixMinutesAgo(minutesAgo),
  }),
});

const statusAnswer = (
  orderReference: string,
  transactionStatus: string,
): Answer => ({
  kind: 'status',
  response: { reasonCode: 1100, orderReference, transactionStatus },
});

/** A canned CHECK_STATUS. `onAsk` runs before the answer — a payment landing while
 * WayForPay is being asked. */
const fakeWayForPay = (
  answers: Readonly<Record<string, Answers>>,
  onAsk: (orderReference: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const asked: string[] = [];
  const client = {
    checkStatus: (orderReference: string) => {
      const answer = answerAt(
        answers[orderReference],
        asked.filter((ref) => ref === orderReference).length,
      );
      asked.push(orderReference);
      return onAsk(orderReference).pipe(
        Effect.andThen(() => {
          switch (answer.kind) {
            case 'status':
              return Effect.succeed(answer.response);
            case 'api_error':
              return Effect.fail(answer.error);
            case 'transport_error':
              return Effect.fail(
                new W4pTransportError({
                  endpoint: 'CHECK_STATUS',
                  status: 502,
                }),
              );
            case 'hang':
              return Effect.never;
            case 'not_found':
              return Effect.fail(new W4pOrderNotFoundError({ orderReference }));
          }
        }),
      );
    },
  };
  return { client, asked };
};

type FakeClient = ReturnType<typeof fakeWayForPay>['client'];

const pass = (client: FakeClient, after: UnpaidCursor | null = null) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sweepUnpaidPayNow({ sql, client }, after),
  );

const sweep = (client: FakeClient) =>
  Effect.map(pass(client), ({ closed }) => closed);

/** The running clock with its time frozen at `millis`; with `sleepsEnd`, every sleep ends
 * at once, so a CHECK_STATUS deadline passes the moment it is set. */
const clockAt = (millis: number, sleepsEnd = false) =>
  Effect.map(Effect.clock, (clock): Clock.Clock => {
    const frozen: Clock.Clock = Object.create(clock) as Clock.Clock;
    return Object.assign(frozen, {
      unsafeCurrentTimeMillis: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      ...(sleepsEnd ? { sleep: () => Effect.void } : {}),
    });
  });

/** Run `effect` with a frozen clock (see `clockAt`). */
const withClockAt =
  (millis: number, sleepsEnd = false) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(clockAt(millis, sleepsEnd), (clock) =>
      Effect.withClock(effect, clock),
    );

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

const settle = (charge: Charge) =>
  Effect.flatMap(settlementHandler(), (handle) => handle(asPayload(charge)));

const callback = (ref: string, transactionStatus: string): Charge =>
  normalizeCallback({
    orderReference: ref,
    transactionStatus,
    reasonCode: transactionStatus === 'Approved' ? 1100 : 1124,
    amount: SESSION_AMOUNT_MAJOR,
    currency: 'USD',
    recToken: transactionStatus === 'Approved' ? 'tok_late' : '',
    createdDate: String(Math.floor(Date.now() / 1000)),
  });

const sessionState = (id: string) =>
  `SELECT status || '|' || coalesce("closedReason", '') FROM checkout_sessions WHERE id = '${id}'`;

const OPEN = '1|';
const CLOSED_UNPAID = '4|unpaid';

const STALE = 'sp:unpaid-stale';
const DECLINED_ID = 'chk_unpaid-declined';
const EXPIRED_ID = 'chk_unpaid-expired';
const UNKNOWN_ID = 'chk_unpaid-unknown';
const STUCK_ID = 'chk_unpaid-stuck';

const refusedClosedOnce: EffectScenario = {
  name: 'pay-now unpaid: a lapsed session WayForPay refused, expired, never saw, or holds on an unanswered bank code is closed unpaid, once',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({
      [DECLINED_ID]: declined,
      [EXPIRED_ID]: statusAnswer(EXPIRED_ID, 'Expired'),
      [STUCK_ID]: otpWaitSince(20),
    });
    const closed: number[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(DECLINED_ID, `${STALE}-declined`);
          yield* pending(EXPIRED_ID, `${STALE}-expired`);
          yield* pending(UNKNOWN_ID, `${STALE}-unknown`);
          yield* pending(STUCK_ID, `${STALE}-stuck`);
          closed.push(yield* sweep(client));
          closed.push(yield* sweep(client));
        }),
      ),
    );

    await expectRows(query, [
      [sessionState(DECLINED_ID), CLOSED_UNPAID, 'the declined order closes'],
      [sessionState(EXPIRED_ID), CLOSED_UNPAID, 'the expired order closes'],
      [sessionState(UNKNOWN_ID), CLOSED_UNPAID, 'the unknown order closes'],
      [sessionState(STUCK_ID), CLOSED_UNPAID, 'the stuck bank code closes'],
      [
        `SELECT count(*) FROM domain_events WHERE "externalUserId" LIKE '${STALE}-%'`,
        '0',
        'the close publishes no event',
      ],
    ]);
    assert.deepEqual(closed, [4, 0], 'the first pass closes, the second none');
  },
};

const WINDOW = 'sp:unpaid-window';
const FRESH_ID = 'chk_unpaid-fresh';
const EDGE_ID = 'chk_unpaid-edge';
const OLD_ID = 'chk_unpaid-old';
const NO_DEADLINE_ID = 'chk_unpaid-no-deadline';
const NEVER_SENT_ID = 'chk_unpaid-never-sent';
const OPTIONS_ID = 'chk_unpaid-options';
const CARD_CHECK_ID = 'chk_unpaid-card-check';

const onlyLapsedBareSessions: EffectScenario = {
  name: 'pay-now unpaid: only a sent, option-less pay-now session lapsed between 15 minutes and a week ago is asked about',
  run: async ({ config, query }) => {
    const refusedAll = Object.fromEntries(
      [
        FRESH_ID,
        EDGE_ID,
        OLD_ID,
        NO_DEADLINE_ID,
        NEVER_SENT_ID,
        OPTIONS_ID,
        CARD_CHECK_ID,
      ].map((id) => [id, declined]),
    );
    const { client, asked } = fakeWayForPay(refusedAll);
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(FRESH_ID, `${WINDOW}-fresh`, { lapsedMinutesAgo: 14 });
          yield* pending(EDGE_ID, `${WINDOW}-edge`, { lapsedMinutesAgo: 16 });
          yield* pending(OLD_ID, `${WINDOW}-old`, {
            lapsedMinutesAgo: 7 * 24 * 60 + 1,
          });
          yield* pending(NO_DEADLINE_ID, `${WINDOW}-no-deadline`, {
            lapsedMinutesAgo: null,
          });
          yield* pending(NEVER_SENT_ID, `${WINDOW}-never-sent`, {
            sent: false,
          });
          yield* pending(OPTIONS_ID, `${WINDOW}-options`, {
            withOptions: true,
          });
          yield* pending(CARD_CHECK_ID, `${WINDOW}-card-check`, {
            firstCharge: 'card_check',
          });
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [sessionState(FRESH_ID), OPEN, 'a payer still inside the delay stays'],
      [sessionState(EDGE_ID), CLOSED_UNPAID, 'just past the delay closes'],
      [sessionState(OLD_ID), OPEN, 'past the lookback stays for a manager'],
      [sessionState(NO_DEADLINE_ID), OPEN, 'no payableUntil stays'],
      [sessionState(NEVER_SENT_ID), OPEN, 'never sent to WayForPay stays'],
      [sessionState(OPTIONS_ID), OPEN, 'an options session stays'],
      [sessionState(CARD_CHECK_ID), OPEN, 'a card check is not this sweep’s'],
    ]);
    assert.deepEqual(asked, [EDGE_ID], 'only the lapsed bare session is asked');
  },
};

const LEFT = 'sp:unpaid-left';
const APPROVED_ID = 'chk_unpaid-approved';
const PROCESSING_ID = 'chk_unpaid-processing';
const FRESH_OTP_ID = 'chk_unpaid-fresh-otp';
const OUTAGE_ID = 'chk_unpaid-outage';

const mayStillLandLeftOpen: EffectScenario = {
  name: 'pay-now unpaid: an order approved, in flight, on a fresh bank code, or unreadable stays open',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({
      [APPROVED_ID]: statusAnswer(APPROVED_ID, 'Approved'),
      [PROCESSING_ID]: statusAnswer(PROCESSING_ID, 'InProcessing'),
      [FRESH_OTP_ID]: otpWaitSince(5),
      [OUTAGE_ID]: { kind: 'transport_error' },
    });
    const closed: number[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(APPROVED_ID, `${LEFT}-approved`);
          yield* pending(PROCESSING_ID, `${LEFT}-processing`);
          yield* pending(FRESH_OTP_ID, `${LEFT}-fresh-otp`);
          yield* pending(OUTAGE_ID, `${LEFT}-outage`);
          closed.push(yield* sweep(client));
        }),
      ),
    );

    await expectRows(query, [
      [
        sessionState(APPROVED_ID),
        OPEN,
        'an approved order waits for its callback',
      ],
      [sessionState(PROCESSING_ID), OPEN, 'an order in flight stays'],
      [sessionState(FRESH_OTP_ID), OPEN, 'a payer typing the code stays'],
      [sessionState(OUTAGE_ID), OPEN, 'an outage leaves it for the next pass'],
    ]);
    assert.deepEqual(closed, [0], 'nothing closed');
  },
};

const RACE = 'sp:unpaid-race';
const RACE_ID = 'chk_unpaid-race';

const paidWhileAsking: EffectScenario = {
  name: 'pay-now unpaid: a payment that settles while WayForPay is being asked keeps the session completed',
  run: async ({ config, query }) => {
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const context = yield* Effect.context<SqlClient.SqlClient | Outbox>();
          const payNow = settle(callback(RACE_ID, 'Approved')).pipe(
            Effect.provide(context),
            Effect.orDie,
          );
          const { client } = fakeWayForPay(
            { [RACE_ID]: declined },
            () => payNow,
          );
          yield* pending(RACE_ID, RACE);
          yield* sweep(client);
        }),
      ),
    );

    await expectRows(query, [
      [sessionState(RACE_ID), '2|', 'the paid session stays Completed'],
      [
        `SELECT count(*) FROM payments WHERE "externalUserId" = '${RACE}'`,
        '1',
        'the payment stands',
      ],
    ]);
  },
};

const LATE = 'sp:unpaid-late';
const LATE_ID = 'chk_unpaid-late';
const CONTROL = 'sp:unpaid-control';
const CONTROL_ID = 'chk_unpaid-control';

const lateMoneyQuarantined: EffectScenario = {
  name: 'pay-now unpaid: money arriving for a closed session is quarantined and a decline consumed; neither books a payment or publishes for the member',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({ [LATE_ID]: declined });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(LATE_ID, LATE);
          yield* pending(CONTROL_ID, CONTROL, { lapsedMinutesAgo: 5 });
          yield* sweep(client);
          yield* settle(callback(LATE_ID, 'Declined'));
          yield* settle(callback(LATE_ID, 'Approved'));
          yield* settle(callback(CONTROL_ID, 'Approved'));
        }),
      ),
    );

    await expectRows(query, [
      [sessionState(LATE_ID), CLOSED_UNPAID, 'the session stays Closed'],
      [
        `SELECT count(*) FROM payments WHERE "externalUserId" = '${LATE}'`,
        '0',
        'no payment is created',
      ],
      [
        `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${LATE}'`,
        '0',
        'no money is fixed',
      ],
      [
        `SELECT count(*) FROM domain_events WHERE "externalUserId" = '${LATE}'`,
        '0',
        'no payment, failure or migration event for the member',
      ],
      [
        `SELECT count(*) FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = '${LATE_ID}' AND c.status = 'succeeded' AND q.status = 'open'`,
        '1',
        'the late payment waits in quarantine as a refund candidate',
      ],
      [
        `SELECT count(*) FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = '${LATE_ID}' AND c.status = 'failed'`,
        '0',
        'the late decline is no refund candidate',
      ],
      [
        `SELECT "matchResult" FROM charges WHERE "externalRef" = '${LATE_ID}' AND status = 'failed'`,
        'matched',
        'the late decline is consumed',
      ],
      [
        `SELECT count(*) FROM payments WHERE "externalUserId" = '${CONTROL}'`,
        '1',
        'the same callback on an open session books the payment',
      ],
    ]);
  },
};

const CROWD = 'sp:unpaid-crowd';
const CROWD_OLDER_ID = 'chk_unpaid-crowd-older';

const notStarved: EffectScenario = {
  name: 'pay-now unpaid: a full batch of newer sessions WayForPay keeps in flight does not hide an older declined one',
  run: async ({ config, query }) => {
    const inFlight = Array.from(
      { length: UNPAID_BATCH },
      (_, n) => `chk_unpaid-crowd-${String(n)}`,
    );
    const { client } = fakeWayForPay({
      ...Object.fromEntries(
        inFlight.map((id) => [id, statusAnswer(id, 'InProcessing')]),
      ),
      [CROWD_OLDER_ID]: declined,
    });
    const afterFirst: string[] = [];
    const nextOfSecond: (UnpaidCursor | null)[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* Effect.forEach(
            inFlight,
            (id) => pending(id, `${CROWD}-${id}`, { lapsedMinutesAgo: 20 }),
            { discard: true },
          );
          yield* pending(CROWD_OLDER_ID, `${CROWD}-older`, {
            lapsedMinutesAgo: 60,
          });
          const first = yield* pass(client);
          const sql = yield* SqlClient.SqlClient;
          const state = yield* sql<{ readonly status: number }>`
            SELECT status FROM checkout_sessions WHERE id = ${CROWD_OLDER_ID}
          `;
          afterFirst.push(String(state[0]?.status));
          const second = yield* pass(client, first.next);
          nextOfSecond.push(second.next);
        }),
      ),
    );

    assert.deepEqual(afterFirst, ['1'], 'the first pass asks the newer batch');
    await expectRows(query, [
      [
        sessionState(CROWD_OLDER_ID),
        CLOSED_UNPAID,
        'the next pass reaches the older declined session',
      ],
    ]);
    assert.deepEqual(
      nextOfSecond,
      [null],
      'after the last candidate the sweep starts again from the top',
    );
  },
};

const EDGES = 'sp:unpaid-edges';
const ON_DELAY_ID = 'chk_unpaid-on-delay';
const UNDER_DELAY_ID = 'chk_unpaid-under-delay';
const ON_LOOKBACK_ID = 'chk_unpaid-on-lookback';
const INSIDE_LOOKBACK_ID = 'chk_unpaid-inside-lookback';

const selectionEdges: EffectScenario = {
  name: 'pay-now unpaid: a session lapsed exactly the delay ago is asked, one a millisecond short is not; exactly the lookback ago is not, a millisecond inside is',
  run: async ({ config, query }) => {
    const now = Date.now();
    const delayMillis = PAY_NOW_UNPAID_AFTER_SECONDS * 1000;
    const lookbackMillis = PAY_NOW_UNPAID_LOOKBACK_SECONDS * 1000;
    const { client, asked } = fakeWayForPay({
      [ON_DELAY_ID]: declined,
      [UNDER_DELAY_ID]: declined,
      [ON_LOOKBACK_ID]: declined,
      [INSIDE_LOOKBACK_ID]: declined,
    });
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(ON_DELAY_ID, `${EDGES}-on-delay`, {
            payableUntil: new Date(now - delayMillis),
          });
          yield* pending(UNDER_DELAY_ID, `${EDGES}-under-delay`, {
            payableUntil: new Date(now - delayMillis + 1),
          });
          yield* pending(ON_LOOKBACK_ID, `${EDGES}-on-lookback`, {
            payableUntil: new Date(now - lookbackMillis),
          });
          yield* pending(INSIDE_LOOKBACK_ID, `${EDGES}-inside-lookback`, {
            payableUntil: new Date(now - lookbackMillis + 1),
          });
          yield* sweep(client).pipe(withClockAt(now));
        }),
      ),
    );

    await expectRows(query, [
      [sessionState(ON_DELAY_ID), CLOSED_UNPAID, 'on the delay closes'],
      [sessionState(UNDER_DELAY_ID), OPEN, 'just short of the delay stays'],
      [sessionState(ON_LOOKBACK_ID), OPEN, 'on the lookback stays'],
      [
        sessionState(INSIDE_LOOKBACK_ID),
        CLOSED_UNPAID,
        'just inside the lookback closes',
      ],
    ]);
    assert.deepEqual(
      [...asked].sort(),
      [INSIDE_LOOKBACK_ID, ON_DELAY_ID].sort(),
      'only the two inside the window are asked',
    );
  },
};

const SLOW = 'sp:unpaid-slow';
const SLOW_ID = 'chk_unpaid-slow';

const timeoutRetried: EffectScenario = {
  name: 'pay-now unpaid: a CHECK_STATUS past its deadline leaves the session open, and the next pass closes it on the decline',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({
      [SLOW_ID]: [{ kind: 'hang' }, declined],
    });
    const states: string[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* pending(SLOW_ID, SLOW);
          const sql = yield* SqlClient.SqlClient;
          const status = sql<{ readonly status: number }>`
            SELECT status FROM checkout_sessions WHERE id = ${SLOW_ID}
          `.pipe(Effect.map((rows) => String(rows[0]?.status)));
          yield* sweep(client).pipe(withClockAt(Date.now(), true));
          states.push(yield* status);
          yield* sweep(client);
          states.push(yield* status);
        }),
      ),
    );

    assert.deepEqual(
      states,
      ['1', '4'],
      'open after the timed-out pass, closed after the next',
    );
    await expectRows(query, [
      [sessionState(SLOW_ID), CLOSED_UNPAID, 'closed unpaid'],
    ]);
  },
};

const CLOSED_AFTER_MATCH = 'sp:unpaid-closed-after-match';
const CLOSED_AFTER_MATCH_ID = 'chk_unpaid-closed-after-match';

/** The production checkout applier, run only after the sweep has closed the session on
 * its own connection: the charge was matched while the session was open. */
const closingBeforeApply = (sql: SqlClient.SqlClient, client: FakeClient) => {
  const real = makeCheckoutApplier(
    makePaymentRepo(sql),
    makeCheckoutRepo(sql),
    ledgerApproval(sql),
  );
  const applier: ChargeApplier = (event, match) =>
    sweepUnpaidPayNow({ sql, client }).pipe(
      Effect.mapInputContext((context: Context.Context<never>) =>
        Context.omit(SqlClient.TransactionConnection)(context),
      ),
      Effect.andThen(real(event, match)),
    );
  return applier;
};

const closedAfterMatch: EffectScenario = {
  name: 'pay-now unpaid: a payment matched while the session was open, then closed by the sweep before it settles, is quarantined as paid-a-closed-session; a replay changes nothing',
  run: async ({ config, query }) => {
    const { client } = fakeWayForPay({ [CLOSED_AFTER_MATCH_ID]: declined });
    const paid = callback(CLOSED_AFTER_MATCH_ID, 'Approved');
    const logs: string[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* pending(CLOSED_AFTER_MATCH_ID, CLOSED_AFTER_MATCH);
          const racing = yield* settlementHandler({
            applier: closingBeforeApply(sql, client),
          });
          const captured = capturingLogs(racing(asPayload(paid)));
          yield* captured.effect;
          logs.push(...captured.messages);
          yield* settle(paid);
        }),
      ),
    );

    await expectRows(query, [
      [
        sessionState(CLOSED_AFTER_MATCH_ID),
        CLOSED_UNPAID,
        'the session stays Closed',
      ],
      [
        `SELECT count(*) FROM payments WHERE "externalUserId" = '${CLOSED_AFTER_MATCH}'`,
        '0',
        'no payment is created',
      ],
      [
        `SELECT count(*) FROM charge_fixations WHERE "externalUserId" = '${CLOSED_AFTER_MATCH}'`,
        '0',
        'no money is fixed',
      ],
      [
        `SELECT count(*) FROM domain_events WHERE "externalUserId" = '${CLOSED_AFTER_MATCH}'`,
        '0',
        'no success or migration event for the member',
      ],
      [
        `SELECT count(*) FROM quarantine_records q JOIN charges c ON c.id = q."incomingEventId" WHERE c."externalRef" = '${CLOSED_AFTER_MATCH_ID}' AND q.status = 'open'`,
        '1',
        'one quarantine record, the replay included',
      ],
      [
        `SELECT count(*) FROM domain_events WHERE name = 'unknown_payment_quarantined' AND payload->>'externalRef' = '${CLOSED_AFTER_MATCH_ID}'`,
        '1',
        'one quarantine notice, the replay included',
      ],
    ]);
    assert.ok(
      logs.includes('SETTLEMENT_ANOMALY checkout: paid a closed session'),
      'the anomaly names the closed session, not an already-settled one',
    );
  },
};

const FULL = 'sp:unpaid-full';

const exactlyFullBatchWraps: EffectScenario = {
  name: 'pay-now unpaid: a batch that ends exactly at the last candidate starts the next pass from the top',
  run: async ({ config }) => {
    const ids = Array.from(
      { length: UNPAID_BATCH },
      (_, n) => `chk_unpaid-full-${String(n)}`,
    );
    const { client } = fakeWayForPay(
      Object.fromEntries(
        ids.map((id) => [id, statusAnswer(id, 'InProcessing')]),
      ),
    );
    const cursors: (UnpaidCursor | null)[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* Effect.forEach(ids, (id) => pending(id, `${FULL}-${id}`), {
            discard: true,
          });
          cursors.push((yield* pass(client)).next);
        }),
      ),
    );

    assert.deepEqual(cursors, [null], 'no empty pass behind a full batch');
  },
};

const WRAP = 'sp:unpaid-wrap';
const WRAP_TARGET_ID = 'chk_unpaid-wrap-target';
const WRAP_OLDEST_ID = 'chk_unpaid-wrap-oldest';

/** The newest session (its first answer is unreadable), a batch's worth in flight behind
 * it, and one older still, so the first pass leaves a cursor. */
const seedWrap = (inFlight: readonly string[]) =>
  Effect.gen(function* () {
    yield* pending(WRAP_TARGET_ID, `${WRAP}-target`, {
      lapsedMinutesAgo: 16,
    });
    yield* Effect.forEach(
      inFlight,
      (id) => pending(id, `${WRAP}-${id}`, { lapsedMinutesAgo: 20 }),
      { discard: true },
    );
    yield* pending(WRAP_OLDEST_ID, `${WRAP}-oldest`, {
      lapsedMinutesAgo: 60,
    });
  });

const unreadableAskedAfterWrap: EffectScenario = {
  name: 'pay-now unpaid: a session whose status could not be read stays open and is asked again, and closed, once the traversal wraps',
  run: async ({ config, query }) => {
    const inFlight = Array.from(
      { length: UNPAID_BATCH - 1 },
      (_, n) => `chk_unpaid-wrap-${String(n)}`,
    );
    const { client } = fakeWayForPay({
      ...Object.fromEntries(
        inFlight.map((id) => [id, statusAnswer(id, 'InProcessing')]),
      ),
      [WRAP_TARGET_ID]: [{ kind: 'transport_error' }, declined],
      [WRAP_OLDEST_ID]: statusAnswer(WRAP_OLDEST_ID, 'InProcessing'),
    });
    const states: string[] = [];
    const wrapped: boolean[] = [];
    await withWorker(config, (run) =>
      run(
        Effect.gen(function* () {
          yield* seedWrap(inFlight);
          const sql = yield* SqlClient.SqlClient;
          const status = sql<{ readonly status: number }>`
            SELECT status FROM checkout_sessions WHERE id = ${WRAP_TARGET_ID}
          `.pipe(Effect.map((rows) => String(rows[0]?.status)));
          const first = yield* pass(client);
          states.push(yield* status);
          const second = yield* pass(client, first.next);
          states.push(yield* status);
          yield* pass(client, second.next);
          states.push(yield* status);
          wrapped.push(first.next === null, second.next === null);
        }),
      ),
    );

    assert.deepEqual(
      wrapped,
      [false, true],
      'the first pass keeps a cursor, the second reaches the end',
    );
    assert.deepEqual(
      states,
      ['1', '1', '4'],
      'open after the unreadable answer and behind the cursor, closed after the wrap',
    );
    await expectRows(query, [
      [sessionState(WRAP_TARGET_ID), CLOSED_UNPAID, 'closed unpaid'],
    ]);
  },
};

export const payNowUnpaidScenarios: readonly EffectScenario[] = [
  refusedClosedOnce,
  onlyLapsedBareSessions,
  mayStillLandLeftOpen,
  paidWhileAsking,
  lateMoneyQuarantined,
  notStarved,
  selectionEdges,
  timeoutRetried,
  closedAfterMatch,
  exactlyFullBatchWraps,
  unreadableAskedAfterWrap,
];
