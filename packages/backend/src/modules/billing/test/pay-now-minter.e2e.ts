import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import {
  CheckoutSessionKind,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Clock, Effect, Option } from 'effect';

import type { AppConfig } from '@/config.js';
import { Queue } from '@/infra/queue/service.js';
import {
  DAY_MS,
  ledgerClaimAdvance,
  scheduleTick,
  type SchedulerConfig,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';
import type { Charge } from '@/modules/charge/contracts.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import {
  captureLogs,
  type Check,
  drain,
  type EffectScenario,
  expectRows,
  HOUR,
  registerHandlers,
  seedSub,
  withWorker,
} from '@/modules/charge/test/e2e-harness.js';
import {
  findRecentProlongClaim,
  makeCheckoutRepo,
} from '@/modules/checkout/data-access.js';
import { Outbox } from '@/modules/outbox/domain.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import { addPeriod } from '@/modules/payment/period.js';
import type { W4pChargeResponse } from '@/modules/wayforpay/contracts.js';
import {
  lapseEnqueuer,
  manualCheckoutMinter,
  payNowMinter,
} from '@/worker-boot.js';

/**
 * The pay-now link against real Postgres: one session per (sub, due date) minted by the
 * notice sweep, settled through the real pipeline, and the near-due guard deciding on
 * real row locks. Only the provider client, the SendPulse check and the clock are fake.
 * The notice predicate reads Postgres `now()`, so the guard scenarios anchor to real time
 * and prove "no second notice" by running that predicate with a literal Kyiv date.
 */
const MINUTE = 60_000;
const USD = 1;
const P1M = 'P1M';
const BASE_AMOUNT = 30000;

interface Knobs {
  readonly cycles?: readonly number[];
  readonly whitepay?: boolean;
}

/** The scenario config with the two knobs the minter reads (cycles `1,3,6` and
 * WhitePay on unless told otherwise). */
const withKnobs = (config: AppConfig, knobs: Knobs = {}): AppConfig => ({
  ...config,
  whitepay: { ...config.whitepay, enabled: knobs.whitepay ?? true },
  scheduler: {
    ...config.scheduler,
    manualRenewalCycleOptions: knobs.cycles ?? [1, 3, 6],
  },
});

const tickConfig = (noticeDays: readonly number[]): SchedulerConfig => ({
  intervalSeconds: 60,
  batchSize: 10,
  upcomingChargeNoticeDays: noticeDays,
  payNowClaimGraceSeconds: 3600,
});

const realClock = Clock.make();

/** A clock frozen at `ms`; sleeping still waits in real time. */
const clockAt = (ms: number): Clock.Clock => ({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  unsafeCurrentTimeMillis: () => ms,
  currentTimeMillis: Effect.succeed(ms),
  unsafeCurrentTimeNanos: () => BigInt(ms) * BigInt(1_000_000),
  currentTimeNanos: Effect.succeed(BigInt(ms) * BigInt(1_000_000)),
  sleep: (duration) => realClock.sleep(duration),
});

/** What the fakes were asked to do: charge order references, manual-mint sub ids. */
interface Recorder {
  readonly charges: string[];
  readonly manual: string[];
}

const newRecorder = (): Recorder => ({ charges: [], manual: [] });

const APPROVED: W4pChargeResponse = {
  transactionStatus: 'Approved',
  createdDate: '1700000000',
};

/** Scheduler deps on the scenario DB: the real repos, minters and claim lookup, a
 * recording approving client and a recording manual minter. */
const depsFor = (
  cfg: AppConfig,
  rec: Recorder,
  overrides: Partial<SchedulerDeps>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const manual = manualCheckoutMinter(sql, cfg);
    const deps: SchedulerDeps = {
      subs: makePaymentRepo(sql),
      client: {
        charge: (request) =>
          Effect.sync(() => {
            rec.charges.push(request.orderReference);
            return APPROVED;
          }),
      },
      ingest: (yield* ChargePipeline).ingest,
      publish: (yield* Outbox).publish,
      lapse: lapseEnqueuer(sql),
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.die('no upstream cancel expected'),
      claimAdvance: ledgerClaimAdvance(sql),
      mintPayNow: payNowMinter(makeCheckoutRepo(sql), cfg),
      recentProlongClaim: (sub, since) =>
        findRecentProlongClaim(sql)(sub.id, since),
      createManualCheckout: (sub, now) =>
        Effect.suspend(() => {
          rec.manual.push(sub.id);
          return manual(sub, now);
        }),
      ...overrides,
    };
    return deps;
  });

interface TickOptions {
  readonly noticeDays?: readonly number[];
  /** Freeze the Effect clock here; real time when absent. */
  readonly at?: number;
  readonly overrides?: Partial<SchedulerDeps>;
}

const tick = (cfg: AppConfig, rec: Recorder, options: TickOptions = {}) => {
  const once = depsFor(cfg, rec, options.overrides ?? {}).pipe(
    Effect.flatMap((deps) =>
      scheduleTick(deps, tickConfig(options.noticeDays ?? [])),
    ),
  );
  return options.at === undefined
    ? once
    : Effect.withClock(once, clockAt(options.at));
};

interface Seed {
  readonly who: string;
  readonly due: Date;
  readonly crypto?: boolean;
}

/** An Active monthly sub paid through `due`: a card with a token, or token-less crypto. */
const seed = ({ who, due, crypto = false }: Seed) =>
  Effect.gen(function* () {
    const subs = makePaymentRepo(yield* SqlClient.SqlClient);
    return yield* seedSub(subs, {
      externalUserId: who,
      end: due,
      period: P1M,
      ...(crypto
        ? { method: PaymentMethod.Crypto, token: null, currency: USD }
        : {}),
    });
  });

/** Noon in Kyiv, `days` Kyiv calendar days from the database's today: the notice day. */
const kyivNoonIn = (days: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly at: Date }>`
      SELECT ((((now() AT TIME ZONE 'Europe/Kyiv')::date + ${days}::int)
               + time '12:00') AT TIME ZONE 'Europe/Kyiv') AS at
    `;
    return rows[0]?.at ?? (yield* Effect.die('no Kyiv noon'));
  });

/** The Kyiv calendar date of `at`, computed off the database (YYYY-MM-DD). */
const kyivDate = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

const ms = (at: Date | number): string =>
  (typeof at === 'number' ? at : at.getTime()).toString();

const payNowKey = (sub: Payment): string =>
  `paynow:${sub.id}:${ms(sub.nextPaymentDate)}`;

/** Mint the sub's pay-now link directly and read back the session it names. */
const mint = (cfg: AppConfig, sub: Payment) =>
  Effect.gen(function* () {
    const repo = makeCheckoutRepo(yield* SqlClient.SqlClient);
    const link = yield* payNowMinter(repo, cfg)(sub);
    const held = yield* repo.findByIdempotencyKey(payNowKey(sub));
    const sessionId = yield* Option.match(held, {
      onNone: () => Effect.die(`no session under ${payNowKey(sub)}`),
      onSome: (session) => Effect.succeed(session.id),
    });
    return { link, sessionId };
  });

interface Paid {
  readonly crypto?: boolean;
  readonly amount?: number;
}

/** A succeeded provider callback for checkout reference `ref` (three cycles' price by
 * default). */
const callback = (ref: string, at: Date, paid: Paid = {}): Charge => ({
  source: paid.crypto === true ? 'whitepay_callback' : 'wayforpay_callback',
  idemKey: `${paid.crypto === true ? 'wp' : 'w4pcb'}:${ref}|succeeded`,
  externalRef: ref,
  externalUserId: null,
  amount: paid.amount ?? 3 * BASE_AMOUNT,
  currency: paid.crypto === true ? USD : 0,
  status: 'succeeded',
  occurredAt: at,
  payload: {},
});

/** Enqueue the callback through the real pipeline and drain the queue. */
const settle = (event: Charge) =>
  Effect.gen(function* () {
    yield* (yield* ChargePipeline).ingest(event);
    yield* drain;
  });

const claim = (sessionId: string, method: number, at: number) =>
  Effect.gen(function* () {
    const claimed = yield* makeCheckoutRepo(
      yield* SqlClient.SqlClient,
    ).claimForPayment(sessionId, method, new Date(at));
    assert.ok(claimed, 'the buyer claimed the pay-now session');
  });

const msSql = (column: string, id: string) =>
  `SELECT (extract(epoch FROM "${column}") * 1000)::bigint FROM payments WHERE id = '${id}'`;

const countEvents = (name: string, id: string) =>
  `SELECT count(*) FROM domain_events WHERE name = '${name}' AND "aggregateId" = '${id}'`;

const noticeOf = (id: string, field: string) =>
  `SELECT (payload->'${field}')::text FROM domain_events WHERE name = 'upcoming_charge' AND "aggregateId" = '${id}'`;

/** `findUpcomingForNotice`'s WHERE clause verbatim, with `kyivToday` (a SQL date
 * expression) in place of the database's Kyiv today. */
const noticeIdsSql = (kyivToday: string, days: number) =>
  `SELECT coalesce(string_agg(id::text, ',' ORDER BY id::text), '') FROM payments
   WHERE recurring = true
     AND status = ${PaymentStatus.Active.toString()}
     AND "cancelRequestedAt" IS NULL
     AND "firstFailureAt" IS NULL
     AND "retryAttempt" = 0
     AND "nextPaymentDate" <= "currentPeriodEnd"
     AND ("nextPaymentDate" AT TIME ZONE 'Europe/Kyiv')::date
         = (${kyivToday} + ${days.toString()}::int)`;

/** The sub's paid-through end and next charge are both `end`; its terms did not move. */
const stackedTo = (id: string, end: Date): readonly Check[] => [
  [msSql('currentPeriodEnd', id), ms(end), 'the paid time stacked on the end'],
  [msSql('nextPaymentDate', id), ms(end), 'the next charge is the new end'],
  [
    `SELECT amount || '|' || period FROM payments WHERE id = '${id}'`,
    `${BASE_AMOUNT.toString()}|${P1M}`,
    'the base terms are unchanged',
  ],
];

// ---------------------------------------------------------------------------------
// P1–P5: the minter on the notice sweep
// ---------------------------------------------------------------------------------

const sessionsOf = (id: string, select: string) =>
  `SELECT ${select} FROM checkout_sessions WHERE "renewalOf" = '${id}'`;

const p1Checks = (sub: Payment): readonly Check[] => [
  [sessionsOf(sub.id, 'count(*)'), '1', 'three ticks, one session'],
  [sessionsOf(sub.id, '"idempotencyKey"'), payNowKey(sub), 'the pay-now key'],
  [sessionsOf(sub.id, 'origin'), 'prolong', 'a prolong session'],
  [
    sessionsOf(sub.id, '(extract(epoch FROM "expiresAt") * 1000)::bigint'),
    ms(sub.nextPaymentDate),
    'live until the due date',
  ],
  [
    `SELECT string_agg(o->>'cycles', ',') FROM checkout_sessions c,
       jsonb_array_elements(c.options) o WHERE c."renewalOf" = '${sub.id}'`,
    '1,3,6',
    'three cycle options',
  ],
  [
    `SELECT count(*) FROM domain_events WHERE name = 'upcoming_charge'`,
    '1',
    'one notice for the three ticks',
  ],
  [noticeOf(sub.id, 'cycleOptions'), '[1, 3, 6]', 'the notice offers them'],
];

const p1ThreeTicksOneSession: EffectScenario = {
  name: 'P1: three notice ticks mint one pay-now session (key, prolong, renewalOf, expiresAt, three cycles); a direct mint returns the same URL',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const out = await run(
        Effect.gen(function* () {
          const sub = yield* seed({ who: 'sp:p1', due: yield* kyivNoonIn(3) });
          yield* Effect.repeatN(
            tick(cfg, newRecorder(), { noticeDays: [3] }),
            2,
          );
          return { sub, again: (yield* mint(cfg, sub)).link };
        }),
      );
      await expectRows(query, p1Checks(out.sub));
      const sent = (
        await query(
          `SELECT payload->>'checkoutUrl' FROM domain_events WHERE name = 'upcoming_charge'`,
        )
      ).trim();
      assert.equal(out.again.checkoutUrl, sent, 'a second mint, same URL');
      assert.deepEqual(out.again.cycleOptions, [1, 3, 6]);
    }),
};

const p2SingleCycle: EffectScenario = {
  name: 'P2: with the cycle knob at "1" the session has no options and the notice offers [1]',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config, { cycles: [1] });
      const sub = await run(
        Effect.gen(function* () {
          const seeded = yield* seed({
            who: 'sp:p2',
            due: yield* kyivNoonIn(3),
          });
          yield* tick(cfg, newRecorder(), { noticeDays: [3] });
          return seeded;
        }),
      );
      await expectRows(query, [
        [sessionsOf(sub.id, '(options IS NULL)::text'), 'true', 'no options'],
        [noticeOf(sub.id, 'cycleOptions'), '[1]', 'one cycle offered'],
      ]);
    }),
};

const p3CryptoWithoutWhitePay: EffectScenario = {
  name: 'P3: a crypto sub while WhitePay is off is noticed with no link and no session; a card sub in the same tick still gets one',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config, { whitepay: false });
      const subs = await run(
        Effect.gen(function* () {
          const due = yield* kyivNoonIn(3);
          const crypto = yield* seed({ who: 'sp:p3c', due, crypto: true });
          const card = yield* seed({ who: 'sp:p3k', due });
          yield* tick(cfg, newRecorder(), { noticeDays: [3] });
          return { crypto, card };
        }),
      );
      const { crypto, card } = subs;
      await expectRows(query, [
        [noticeOf(crypto.id, 'checkoutUrl'), 'null', 'no link for crypto'],
        [noticeOf(crypto.id, 'cycleOptions'), '[]', 'no cycles either'],
        [sessionsOf(crypto.id, 'count(*)'), '0', 'no session for crypto'],
        [sessionsOf(card.id, 'count(*)'), '1', 'the card sub got a session'],
        [
          `SELECT (payload->>'checkoutUrl' IS NOT NULL)::text FROM domain_events
             WHERE name = 'upcoming_charge' AND "aggregateId" = '${card.id}'`,
          'true',
          'and its notice carries the link',
        ],
      ]);
    }),
};

const plantForeign = (sub: Payment) =>
  Effect.gen(function* () {
    yield* makeCheckoutRepo(yield* SqlClient.SqlClient).insert({
      id: 'chk_foreign',
      externalUserId: 'sp:someone-else',
      amount: BASE_AMOUNT,
      currency: 0,
      period: P1M,
      method: PaymentMethod.Card,
      email: '',
      kind: CheckoutSessionKind.Checkout,
      recurring: true,
      paymentId: null,
      successUrl: null,
      failureUrl: null,
      promo: null,
      renewal: null,
      origin: null,
      renewalOf: 'pay_other',
      options: null,
      idempotencyKey: payNowKey(sub),
      expiresAt: new Date(Date.now() + DAY_MS),
    });
  });

const FOREIGN_ROW = `SELECT row_to_json(c)::text FROM checkout_sessions c WHERE id = 'chk_foreign'`;

const p4ForeignHolder: EffectScenario = {
  name: 'P4: a foreign session under the pay-now key is never sent: the notice has no link, it alerts once, the planted row is untouched',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const sub = await run(
        Effect.gen(function* () {
          const seeded = yield* seed({
            who: 'sp:p4',
            due: yield* kyivNoonIn(3),
          });
          yield* plantForeign(seeded);
          return seeded;
        }),
      );
      const before = await query(FOREIGN_ROW);
      const logs = captureLogs();
      await run(
        tick(cfg, newRecorder(), { noticeDays: [3] }).pipe(
          Effect.provide(logs.layer),
        ),
      );
      await expectRows(query, [
        [noticeOf(sub.id, 'checkoutUrl'), 'null', 'no foreign link sent'],
        [`SELECT count(*) FROM checkout_sessions`, '1', 'nothing minted'],
      ]);
      assert.equal(await query(FOREIGN_ROW), before, 'planted row unchanged');
      const alerts = logs.lines.filter((line) =>
        line.includes(
          'pay-now checkout: idempotency key held by a foreign session',
        ),
      );
      assert.equal(alerts.length, 1, 'one alert line');
    }),
};

const moveDue = (id: string, to: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE payments SET "nextPaymentDate" = ${to}, "currentPeriodEnd" = ${to}
      WHERE id = ${id}
    `;
  });

const p5MovedDueDate: EffectScenario = {
  name: 'P5: a moved due date mints a second pay-now session under its own key',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const sub = await run(
        Effect.gen(function* () {
          const seeded = yield* seed({
            who: 'sp:p5',
            due: yield* kyivNoonIn(3),
          });
          yield* tick(cfg, newRecorder(), { noticeDays: [1, 3] });
          yield* moveDue(seeded.id, yield* kyivNoonIn(1));
          yield* tick(cfg, newRecorder(), { noticeDays: [1, 3] });
          return seeded;
        }),
      );
      await expectRows(query, [
        [sessionsOf(sub.id, 'count(*)'), '2', 'one session per due date'],
        [
          sessionsOf(sub.id, 'count(DISTINCT "idempotencyKey")'),
          '2',
          'under two keys',
        ],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// P6–P9: paying the link ahead of the due date, or not
// ---------------------------------------------------------------------------------

/** A sub due in two days with its pay-now link, paid `_c3` ahead of the due date. */
const paidAhead = (cfg: AppConfig, seedOf: Seed, times = 1) =>
  Effect.gen(function* () {
    yield* registerHandlers;
    const sub = yield* seed(seedOf);
    const { sessionId } = yield* mint(cfg, sub);
    const event = callback(`${sessionId}_c3`, new Date(), {
      crypto: seedOf.crypto ?? false,
    });
    yield* Effect.repeatN((yield* ChargePipeline).ingest(event), times - 1);
    yield* drain;
    return sub;
  });

const inTwoDays = (): Date => new Date(Date.now() + 2 * DAY_MS);

const succeededOf = (id: string) =>
  `SELECT (payload->>'period') || '|' || (payload->>'cycles') || '|' || (payload->>'periodEnd')
     FROM domain_events WHERE name = 'recurring_payment_succeeded' AND "aggregateId" = '${id}'`;

const p6PaidAheadCard: EffectScenario = {
  name: 'P6: a card sub that paid its pay-now link for three cycles is not charged at the due date; it stacked P3M',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const due = inTwoDays();
      const sub = await run(paidAhead(cfg, { who: 'sp:p6', due }));
      await run(tick(cfg, rec, { at: due.getTime() + MINUTE }));
      assert.equal(rec.charges.length, 0, 'charge was never called');
      const end = addPeriod(due, 'P3M');
      await expectRows(query, [
        ...stackedTo(sub.id, end),
        [
          succeededOf(sub.id),
          `P3M|3|${end.toISOString()}`,
          'one renewal success for three cycles',
        ],
      ]);
    }),
};

const p7PaidAheadCrypto: EffectScenario = {
  name: 'P7: a token-less crypto sub paid ahead through WhitePay gets no manual prompt at the due date and is noticed again three days before its new date',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const due = inTwoDays();
      const sub = await run(
        paidAhead(cfg, { who: 'sp:p7', due, crypto: true }),
      );
      await run(tick(cfg, rec, { at: due.getTime() + MINUTE }));
      assert.equal(rec.manual.length, 0, 'no manual checkout minted');
      const end = addPeriod(due, 'P3M');
      await expectRows(query, [
        ...stackedTo(sub.id, end),
        [countEvents('payment_manual_required', sub.id), '0', 'no prompt'],
        [
          `${noticeIdsSql(`('${kyivDate(end)}'::date - 3)`, 3)} AND id = '${sub.id}'`,
          sub.id,
          'the next notice day still selects it',
        ],
      ]);
    }),
};

const p8DuplicateCallback: EffectScenario = {
  name: 'P8: the same pay-now callback enqueued twice stacks once and emits one success',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const due = inTwoDays();
      const sub = await run(paidAhead(cfg, { who: 'sp:p8', due }, 2));
      await expectRows(query, [
        ...stackedTo(sub.id, addPeriod(due, 'P3M')),
        [countEvents('recurring_payment_succeeded', sub.id), '1', 'one'],
      ]);
    }),
};

const p9UnpaidLinks: EffectScenario = {
  name: 'P9: an unpaid pay-now link changes nothing at the due date: the card is charged once, crypto is prompted',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const due = inTwoDays();
      const subs = await run(
        Effect.gen(function* () {
          yield* registerHandlers;
          const card = yield* seed({ who: 'sp:p9k', due });
          const crypto = yield* seed({ who: 'sp:p9c', due, crypto: true });
          yield* mint(cfg, card);
          yield* mint(cfg, crypto);
          yield* tick(cfg, rec, { at: due.getTime() + MINUTE });
          yield* drain;
          return { card, crypto };
        }),
      );
      assert.deepEqual(rec.charges, [
        `${PAYMENT_ORDER_PREFIX}${subs.card.id}_${ms(due)}`,
      ]);
      await expectRows(query, [
        [countEvents('recurring_payment_succeeded', subs.card.id), '1', 'paid'],
        [countEvents('payment_manual_required', subs.crypto.id), '1', 'asked'],
      ]);
    }),
};

// ---------------------------------------------------------------------------------
// P10–P13: the near-due guard on real row locks
// ---------------------------------------------------------------------------------

/** A card sub due a minute before `t`, its pay-now link minted and claimed half an hour
 * before `t`. */
const claimedBefore = (cfg: AppConfig, who: string, t: number) =>
  Effect.gen(function* () {
    yield* registerHandlers;
    const due = new Date(t - MINUTE);
    const sub = yield* seed({ who, due });
    const { sessionId } = yield* mint(cfg, sub);
    yield* claim(sessionId, PaymentMethod.Card, t - 30 * MINUTE);
    return { sub, due, sessionId };
  });

/** The claimed sub, deferred by the tick at `t`. */
const deferredAt = (cfg: AppConfig, rec: Recorder, who: string, t: number) =>
  Effect.gen(function* () {
    const claimed = yield* claimedBefore(cfg, who, t);
    yield* tick(cfg, rec, { at: t });
    return claimed;
  });

const deferredChecks = (id: string, due: Date, t: number): readonly Check[] => [
  [msSql('nextPaymentDate', id), ms(t + DAY_MS), 'deferred 24 h from the tick'],
  [msSql('currentPeriodEnd', id), ms(due), 'the anchor did not move'],
  [countEvents('charge_deferred', id), '1', 'one charge_deferred'],
  [
    `SELECT payload->>'dueDate' FROM domain_events WHERE name = 'charge_deferred' AND "aggregateId" = '${id}'`,
    due.toISOString(),
    'it names the original due date',
  ],
];

const dropPayment = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM payments WHERE id = ${id}`;
  });

const p10Checks = (id: string, due: Date): readonly Check[] => [
  [countEvents('recurring_payment_succeeded', id), '1', 'one renewal success'],
  [msSql('currentPeriodStart', id), ms(due), 'the new period starts at D'],
  [msSql('currentPeriodEnd', id), ms(addPeriod(due, P1M)), 'and ends at D+P'],
];

const p10DeferThenCharge: EffectScenario = {
  name: 'P10: a claim 30 min before the due tick defers the charge 24 h from the tick, once, with no second notice; the next day charges once',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const t = Date.now();
      const control = await run(
        seed({ who: 'sp:p10-ctl', due: new Date(t + DAY_MS) }),
      );
      const { sub, due } = await run(deferredAt(cfg, rec, 'sp:p10', t));
      assert.equal(rec.charges.length, 0, 'no charge on the deferring tick');
      await expectRows(query, deferredChecks(sub.id, due, t));
      const tomorrow = `((to_timestamp(${ms(t + DAY_MS)} / 1000.0) AT TIME ZONE 'Europe/Kyiv')::date - 1)`;
      await expectRows(query, [
        [
          `${noticeIdsSql(tomorrow, 1)} AND id IN ('${sub.id}', '${control.id}')`,
          control.id,
          'the on-time control is noticed, the deferred sub is not',
        ],
      ]);
      // The control has served; it would otherwise be charged on the next tick too.
      await run(dropPayment(control.id));
      await run(
        tick(cfg, rec, { at: t + DAY_MS + MINUTE }).pipe(Effect.andThen(drain)),
      );
      assert.deepEqual(rec.charges, [
        `${PAYMENT_ORDER_PREFIX}${sub.id}_${ms(t + DAY_MS)}`,
      ]);
      await expectRows(query, p10Checks(sub.id, due));
    }),
};

const p11SettledBeforeDue: EffectScenario = {
  name: 'P11: a pay-now callback settled five minutes before the due date leaves the due tick nothing to charge or defer',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const t = Date.now();
      const { sub, due } = await run(
        Effect.gen(function* () {
          const claimed = yield* claimedBefore(cfg, 'sp:p11', t);
          yield* settle(
            callback(
              claimed.sessionId,
              new Date(claimed.due.getTime() - 5 * MINUTE),
              {
                amount: BASE_AMOUNT,
              },
            ),
          );
          yield* tick(cfg, rec, { at: t });
          return claimed;
        }),
      );
      assert.equal(rec.charges.length, 0, 'no charge');
      await expectRows(query, [
        ...stackedTo(sub.id, addPeriod(due, P1M)),
        [countEvents('charge_deferred', sub.id), '0', 'no deferral'],
      ]);
    }),
};

const p12SettledWhileDeferred: EffectScenario = {
  name: 'P12: a three-cycle callback settling two hours into the deferral overwrites the deferred date; the next-day tick does nothing',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const t = Date.now();
      const { sub, due, sessionId } = await run(
        deferredAt(cfg, rec, 'sp:p12', t),
      );
      await run(
        settle(callback(`${sessionId}_c3`, new Date(due.getTime() + 2 * HOUR))),
      );
      await run(tick(cfg, rec, { at: due.getTime() + DAY_MS + MINUTE }));
      assert.equal(rec.charges.length, 0, 'never charged');
      await expectRows(query, [
        ...stackedTo(sub.id, addPeriod(due, 'P3M')),
        [countEvents('payment_manual_required', sub.id), '0', 'no prompt'],
        [countEvents('charge_deferred', sub.id), '1', 'no second deferral'],
      ]);
    }),
};

/** An `upstreamCancelled` that settles `event` for real (enqueue and drain, on the real
 * clock) before answering false: a settlement committing between the due read and the
 * locked decision. */
const settlingUpstreamCheck = (event: Charge) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      ChargePipeline | Queue | SqlClient.SqlClient
    >();
    return (): Effect.Effect<boolean> =>
      settle(event).pipe(
        Effect.withClock(realClock),
        Effect.provide(context),
        Effect.orDie,
        Effect.as(false),
      );
  });

const p13SettledDuringUpstreamCheck: EffectScenario = {
  name: 'P13: a pay-now settlement committing during the upstream check, against real row locks, means no charge and no deferral',
  run: ({ config, query }) =>
    withWorker(config, async (run) => {
      const cfg = withKnobs(config);
      const rec = newRecorder();
      const t = Date.now();
      const { sub, due } = await run(
        Effect.gen(function* () {
          const claimed = yield* claimedBefore(cfg, 'sp:p13', t);
          const upstreamCancelled = yield* settlingUpstreamCheck(
            callback(`${claimed.sessionId}_c3`, new Date(t)),
          );
          yield* tick(cfg, rec, { at: t, overrides: { upstreamCancelled } });
          return claimed;
        }),
      );
      assert.equal(rec.charges.length, 0, 'no charge');
      await expectRows(query, [
        ...stackedTo(sub.id, addPeriod(due, 'P3M')),
        [countEvents('charge_deferred', sub.id), '0', 'no deferral'],
      ]);
    }),
};

export const payNowMinterScenarios: readonly EffectScenario[] = [
  p1ThreeTicksOneSession,
  p2SingleCycle,
  p3CryptoWithoutWhitePay,
  p4ForeignHolder,
  p5MovedDueDate,
  p6PaidAheadCard,
  p7PaidAheadCrypto,
  p8DuplicateCallback,
  p9UnpaidLinks,
  p10DeferThenCharge,
  p11SettledBeforeDue,
  p12SettledWhileDeferred,
  p13SettledDuringUpstreamCheck,
];
