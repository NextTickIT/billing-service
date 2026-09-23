import assert from 'node:assert/strict';

import { SqlClient } from '@effect/sql';
import { CheckoutSessionKind, PaymentStatus } from '@billing-service/shared';
import { Duration, Effect, Option } from 'effect';

import type { AppConfig } from '@/config.js';
import { defaultRetryConfig } from '@/infra/queue/policy.js';
import { Queue } from '@/infra/queue/service.js';
import { enqueue } from '@/infra/queue/store.js';
import { TaskRegistry } from '@/infra/task-registry.js';
import { DELIVER_EVENT } from '@/modules/outbox/contracts.js';
import { Outbox } from '@/modules/outbox/domain.js';
import type { Charge } from '@/modules/charge/contracts.js';
import {
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
} from '@/modules/charge/contracts.js';
import { makeChargeRepo } from '@/modules/charge/data-access.js';
import { ChargePipeline } from '@/modules/charge/domain.js';
import { sinkCancelled } from '@/modules/billing/events.js';
import { scheduleTick } from '@/modules/billing/scheduler.js';
import { normalizeCallback } from '@/modules/wayforpay/callback.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import { cancelNotify, lapseNotify } from '@/modules/payment/cancel.js';
import { PAYMENT_CANCEL, PAYMENT_LAPSE } from '@/modules/payment/contracts.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { makeContactsRepo } from '@/modules/contacts/data-access.js';
import type { W4pTransaction } from '@/modules/wayforpay/contracts.js';
import { makePollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { pollTick } from '@/modules/wayforpay/poller.js';
import { makeWorkerRuntime } from '@/runtime.js';

/**
 * Non-HTTP e2e scenarios: drive the worker pipeline directly against a real,
 * freshly-migrated Postgres (the runner in test/e2e/run.ts creates/migrates/drops
 * a throwaway database around each). This is the DB-integration proof for M1+M2 —
 * dedup, FOR UPDATE SKIP LOCKED, the CTE writes, ON CONFLICT idempotency, and the
 * bind/rebind SQL only run for real here.
 */
export interface EffectE2eContext {
  readonly config: AppConfig;
  /** Read-only SQL against this scenario's throwaway database (via psql). */
  readonly query: (sql: string) => Promise<string>;
}

export interface EffectScenario {
  readonly name: string;
  readonly run: (ctx: EffectE2eContext) => Promise<void>;
}

const charge = (idemKey: string): Charge => ({
  source: 'test',
  idemKey,
  externalRef: 'o1',
  externalUserId: null,
  amount: 30000,
  currency: 0, // UAH
  status: 'succeeded',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  payload: { note: 'e2e' },
});

/** Register the worker handlers the scenarios drive. */
const registerHandlers = Effect.gen(function* () {
  const registry = yield* TaskRegistry;
  const outbox = yield* Outbox;
  const pipeline = yield* ChargePipeline;
  const sql = yield* SqlClient.SqlClient;
  yield* registry.register(PAYMENT_EVENT_RECEIVED, (p) =>
    pipeline.handleFromPayload(p),
  );
  yield* registry.register(PAYMENT_REBIND, (p) =>
    pipeline.rebindFromPayload(p),
  );
  yield* registry.register(DELIVER_EVENT, (p) => outbox.deliverFromPayload(p));
  yield* registry.register(PAYMENT_CANCEL, cancelNotify(outbox.publish));
  yield* registry.register(
    PAYMENT_LAPSE,
    lapseNotify(makePaymentRepo(sql), outbox.publish),
  );
});

/** Run the dispatch loop for `seconds`, then stop (the loop is `Effect<never>`). */
const runFor = (seconds: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue;
    yield* Effect.race(
      queue.run({
        workerId: 'e2e',
        pollIntervalMillis: 50,
        batchSize: 10,
        visibilityTimeoutMillis: 300_000,
        retry: defaultRetryConfig,
      }),
      Effect.sleep(Duration.seconds(seconds)),
    );
  });

const eq = async (
  query: EffectE2eContext['query'],
  sql: string,
  expected: string,
  message: string,
): Promise<void> => {
  assert.equal((await query(sql)).trim(), expected, message);
};

const IDEM_KEY = 'w4p:o1|PURCHASE|1700000000';

/** Ingest the same charge twice, drain, and assert dedup + quarantine + delivery. */
const driveQuarantine = Effect.gen(function* () {
  yield* registerHandlers;
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest(charge(IDEM_KEY));
  yield* pipeline.ingest(charge(IDEM_KEY)); // duplicate receipt
  yield* runFor(3);
});

const assertQuarantine = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM raw_events WHERE "idemKey" = '${IDEM_KEY}'`,
    '2',
    'both receipts appended to raw_events (AC3)',
  );
  await eq(
    query,
    `SELECT count(*) FROM messages WHERE "messageType" = 'payment_event_received'`,
    '1',
    'duplicate deduped to a single message (AC2)',
  );
  await eq(
    query,
    `SELECT count(*) FROM charge_fixations`,
    '0',
    'no charge fixation when unmatched',
  );
  await eq(
    query,
    `SELECT count(*) FROM quarantine_records WHERE status = 'open'`,
    '1',
    'unmatched charge quarantined (AC6)',
  );
  await eq(
    query,
    `SELECT status FROM event_deliveries`,
    'delivered',
    'delivery reached the sink and was marked delivered',
  );
};

const quarantineAndDeliver: EffectScenario = {
  name: 'pipeline: unmatched charge is deduped, quarantined, and delivered',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveQuarantine);
      await assertQuarantine(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const BIND_KEY = 'w4p:o2|PURCHASE|1700000500';

/** Quarantine a charge, then bind it (audit + enqueue rebind) via the real repo. */
const driveBind = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const repo = makeChargeRepo(sql);
  const pipeline = yield* ChargePipeline;

  yield* pipeline.ingest(charge(BIND_KEY));
  yield* runFor(2); // quarantine + deliver

  const open = yield* repo.listOpenQuarantine();
  const record = open[0];
  if (record === undefined) {
    return;
  }
  yield* repo.insertAudit({
    actor: 'Operator',
    action: 'bind_quarantine',
    targetType: 'quarantine',
    targetId: record.quarantineId,
    detail: { externalUserId: 'sp:bound' },
  });
  yield* enqueue(sql)({
    messageType: PAYMENT_REBIND,
    idemKey: `rebind:${record.quarantineId}`,
    payload: {
      incomingEventId: record.incomingEventId,
      quarantineId: record.quarantineId,
      externalUserId: 'sp:bound',
      subscriptionId: null,
      period: 'P1M',
      method: 0,
    },
  });
  yield* runFor(2); // reprocess + deliver
});

const assertBind = async (query: EffectE2eContext['query']): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM charge_fixations WHERE "paymentId" IS NULL`,
    '1',
    'bound charge fixation recorded without a payment yet',
  );
  await eq(
    query,
    `SELECT status FROM quarantine_records`,
    'resolved',
    'quarantine resolved after bind (AC6)',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'recurring_payment_succeeded'`,
    '1',
    'bind emitted recurring_payment_succeeded',
  );
  await eq(
    query,
    `SELECT count(*) FROM audit_log WHERE action = 'bind_quarantine'`,
    '1',
    'operator bind was audited',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both the quarantine and the bound payment were delivered',
  );
};

const bindReprocesses: EffectScenario = {
  name: 'support: operator bind reprocesses a quarantine into a charge fixation (FR-009)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveBind);
      await assertBind(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const journal: readonly W4pTransaction[] = [
  {
    transactionType: 'PURCHASE',
    orderReference: 'p1',
    createdDate: '1700000000',
    amount: '10.00',
    currency: 'UAH',
    transactionStatus: 'Approved',
  },
  {
    transactionType: 'PURCHASE',
    orderReference: 'p2',
    createdDate: '1700000100',
    amount: '20.00',
    currency: 'UAH',
    transactionStatus: 'Approved',
  },
  {
    transactionType: 'SETTLE',
    orderReference: 's1',
    createdDate: '1700000200',
  },
];

/** Poll a canned journal (fake client, no network), then drain the pipeline. */
const drivePoller = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const pipeline = yield* ChargePipeline;
  yield* pollTick(
    {
      client: { transactionList: () => Effect.succeed(journal) },
      ingest: pipeline.ingest,
      state: makePollerStateRepo(sql),
    },
    {
      account: 'acc',
      pollIntervalSeconds: 120,
      windowOverlapSeconds: 900,
      maxWindowSeconds: 21600,
    },
  );
  yield* runFor(2);
});

const assertPoller = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM charges`,
    '2',
    'two charge rows ingested; SETTLE skipped',
  );
  await eq(
    query,
    `SELECT count(*) FROM w4p_poller_state WHERE account = 'acc'`,
    '1',
    'watermark persisted for the account',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both quarantine events delivered',
  );
};

const pollerIngestsJournal: EffectScenario = {
  name: 'poller: journal rows are ingested through the pipeline (FR-008)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(drivePoller);
      await assertPoller(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const CHK_ID = 'chk_e2e';

/** Seed a checkout session, then feed its (normalized) success callback through
 * the pipeline — the checkout matcher + applier turn it into a subscription. */
const driveCheckout = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  yield* makeCheckoutRepo(sql).insert({
    id: CHK_ID,
    externalUserId: 'sp:checkout',
    amount: 30000,
    currency: 0,
    period: 'P1M',
    kind: CheckoutSessionKind.Checkout,
    recurring: true,
    paymentId: null,
    successUrl: null,
    failureUrl: null,
    promo: null,
    idempotencyKey: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest(
    normalizeCallback({
      orderReference: CHK_ID,
      amount: '300',
      currency: 'UAH',
      transactionStatus: 'Approved',
      recToken: 'tok_e2e',
      createdDate: '1700000000',
    }),
  );
  yield* runFor(2);
});

const assertCheckout = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM payments WHERE status = 0`,
    '1',
    'an active subscription was created (AC5)',
  );
  await eq(
    query,
    `SELECT "recurringTokenRef" FROM payments`,
    'tok_e2e',
    'the card token was stored (AC5)',
  );
  await eq(
    query,
    `SELECT "externalUserId" FROM payments`,
    'sp:checkout',
    'external user carried through',
  );
  await eq(
    query,
    `SELECT status FROM checkout_sessions WHERE id = '${CHK_ID}'`,
    '2',
    'the session was marked completed',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'payment_created'`,
    '1',
    'payment_created emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'initial_payment_succeeded'`,
    '1',
    'initial_payment_succeeded emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '2',
    'both events delivered',
  );
};

const checkoutCreatesPayment: EffectScenario = {
  name: 'checkout: a successful charge creates a payment + events (AC5)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCheckout);
      await assertCheckout(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** Insert a due subscription, run one scheduler tick with an approving charge,
 * then let the pipeline record the payment — the FR-004 success path. */
const driveScheduler = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  yield* subs.insert({
    externalUserId: 'sp:sched',
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
  });
  const outbox = yield* Outbox;
  const pipeline = yield* ChargePipeline;
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
      ingest: pipeline.ingest,
      publish: outbox.publish,
      lapse: () => Effect.void,
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.void,
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    { intervalSeconds: 60, batchSize: 10 },
  );
  yield* runFor(2);
});

const assertScheduler = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT to_char("nextPaymentDate", 'YYYY-MM-DD') FROM payments`,
    '2026-02-01',
    'next charge advanced by the period (FR-004)',
  );
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '0',
    'subscription stayed active',
  );
  await eq(
    query,
    `SELECT count(*) FROM charge_fixations`,
    '1',
    'the charge was recorded',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'recurring_payment_succeeded'`,
    '1',
    'recurring_payment_succeeded emitted for the recurring charge',
  );
};

const schedulerChargesDue: EffectScenario = {
  name: 'scheduler: a due subscription is charged and advanced (FR-004)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveScheduler);
      await assertScheduler(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** Cancel an active subscription (like the support route does), then let the
 * worker emit payment_cancelled — the FR-012 path. */
const driveCancel = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:cancel',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: 0,
    recurring: true,
    currentPeriodStart: new Date('2029-12-01T00:00:00Z'),
    currentPeriodEnd: new Date('2030-01-01T00:00:00Z'),
    nextPaymentDate: new Date('2030-01-01T00:00:00Z'),
    recurringTokenRef: 'tok',
    firstFailureAt: null,
    retryAttempt: 0,
  });
  yield* subs.requestCancel(created.id);
  yield* enqueue(sql)({
    messageType: PAYMENT_CANCEL,
    idemKey: `cancel:${created.id}`,
    payload: {
      subscriptionId: created.id,
      externalUserId: 'sp:cancel',
      reason: 'operator',
    },
  });
  yield* runFor(2);
});

const assertCancel = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '0',
    'payment stays active during the grace window (soft-cancel, docs/23)',
  );
  await eq(
    query,
    `SELECT ("cancelRequestedAt" IS NOT NULL)::text FROM payments`,
    'true',
    'cancellation is pending until the due date (docs/23)',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'payment_cancelled'`,
    '1',
    'payment_cancelled emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM event_deliveries WHERE status = 'delivered'`,
    '1',
    'the cancellation event was delivered',
  );
};

const cancelPayment: EffectScenario = {
  name: 'support: operator cancels a payment (FR-012)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCancel);
      await assertCancel(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** Insert a soft-cancelled, past-due payment, then run a scheduler tick: the
 * cancel-pending branch lapses it (enqueue PAYMENT_LAPSE) instead of charging —
 * the WFP client MUST NOT be called. The lapse handler flips it to cancelled and
 * emits the terminal renewal_failed (reason `cancelled`). AC-C1b (docs/23). */
const driveLapse = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:lapse',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: 0,
    recurring: true,
    currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-07-01T00:00:00Z'), // due in the past
    recurringTokenRef: 'tok',
    firstFailureAt: null,
    retryAttempt: 0,
  });
  yield* subs.requestCancel(created.id); // sets cancelRequestedAt = now
  const outbox = yield* Outbox;
  const pipeline = yield* ChargePipeline;
  yield* scheduleTick(
    {
      subs,
      // A soft-cancelled due payment must never be charged.
      client: {
        charge: () => Effect.die('WFP charge must not run on a lapse'),
      },
      ingest: pipeline.ingest,
      publish: outbox.publish,
      lapse: (sub) =>
        enqueue(sql)({
          messageType: PAYMENT_LAPSE,
          idemKey: `lapse:${sub.id}`,
          payload: { paymentId: sub.id, externalUserId: sub.externalUserId },
        }).pipe(Effect.asVoid),
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.void,
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    { intervalSeconds: 60, batchSize: 10 },
  );
  yield* runFor(2);
});

const assertLapse = async (query: EffectE2eContext['query']): Promise<void> => {
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '3',
    'the cancel-pending payment lapsed to cancelled (AC-C1b)',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'renewal_failed'
       AND payload->>'reason' = 'cancelled'`,
    '1',
    'exactly one renewal_failed (reason cancelled) emitted for the lapse',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'charge_retry_failed'`,
    '0',
    'a lapse takes no retry ladder — no charge_retry_failed',
  );
  await eq(
    query,
    `SELECT count(*) FROM charge_fixations`,
    '0',
    'the WFP charge was never invoked (no fixation)',
  );
};

const softCancelLapses: EffectScenario = {
  name: 'scheduler: a soft-cancelled due payment lapses instead of charging (AC-C1b)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveLapse);
      await assertLapse(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const CARD_CHANGE_OWED_ID = 'chk_cc_owed';

/** Seed a past_due payment + an owed card-change session, then feed a succeeded
 * callback carrying the new token: the card-change applier re-tokenizes AND
 * advances the SAME payment (revive in place, one-active-payment invariant). The
 * pipeline emits recurring_payment_succeeded (owed money) + card_change_succeeded.
 * AC-C3b (docs/23). */
const driveCardChangeOwed = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:cc',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.PastDue,
    recurring: true,
    currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-01-08T00:00:00Z'),
    recurringTokenRef: 'old',
    firstFailureAt: new Date('2026-01-01T00:00:00Z'),
    retryAttempt: 2,
  });
  yield* makeCheckoutRepo(sql).insert({
    id: CARD_CHANGE_OWED_ID,
    externalUserId: 'sp:cc',
    amount: 30000, // owed > 0
    currency: 0,
    period: 'P1M',
    kind: CheckoutSessionKind.CardChange,
    recurring: true,
    paymentId: created.id,
    successUrl: null,
    failureUrl: null,
    promo: null,
    idempotencyKey: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest({
    source: 'wayforpay_callback',
    idemKey: 'w4pcb:chk_cc_owed|Approved',
    externalRef: CARD_CHANGE_OWED_ID,
    externalUserId: null,
    amount: 30000,
    currency: 0,
    status: 'succeeded',
    occurredAt: new Date('2026-01-05T00:00:00Z'),
    payload: { recToken: 'new' },
  });
  yield* runFor(2);
});

const assertCardChangeOwed = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT "recurringTokenRef" FROM payments`,
    'new',
    'the card token was rewritten on the existing payment (AC-C3b)',
  );
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '0',
    'the past_due payment was revived to active in place',
  );
  await eq(
    query,
    `SELECT "retryAttempt"::text FROM payments`,
    '0',
    'the retry ladder was reset on the advance',
  );
  await eq(
    query,
    `SELECT to_char("currentPeriodEnd", 'YYYY-MM-DD') FROM payments`,
    '2026-02-01',
    'the period anchor advanced by one period from currentPeriodEnd',
  );
  await eq(
    query,
    `SELECT count(*) FROM payments`,
    '1',
    'advanced by id — no second payment row (one-active-payment invariant)',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'recurring_payment_succeeded'`,
    '1',
    'an owed card change collected money → recurring_payment_succeeded',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'card_change_succeeded'`,
    '1',
    'card_change_succeeded emitted',
  );
};

const cardChangeOwedRevives: EffectScenario = {
  name: 'card-change: an owed change revives a past_due payment in place (AC-C3b)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCardChangeOwed);
      await assertCardChangeOwed(query);
    } finally {
      await runtime.dispose();
    }
  },
};

const CARD_CHANGE_DECLINE_ID = 'chk_cc_declined';

/** Same owed setup, but the card-change callback FAILS: no token rewrite, no
 * advance — the payment is untouched and only card_change_failed is emitted.
 * AC-C3c (docs/23). */
const driveCardChangeDecline = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:ccd',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.PastDue,
    recurring: true,
    currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-01-08T00:00:00Z'),
    recurringTokenRef: 'old',
    firstFailureAt: new Date('2026-01-01T00:00:00Z'),
    retryAttempt: 2,
  });
  yield* makeCheckoutRepo(sql).insert({
    id: CARD_CHANGE_DECLINE_ID,
    externalUserId: 'sp:ccd',
    amount: 30000,
    currency: 0,
    period: 'P1M',
    kind: CheckoutSessionKind.CardChange,
    recurring: true,
    paymentId: created.id,
    successUrl: null,
    failureUrl: null,
    promo: null,
    idempotencyKey: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  });
  const pipeline = yield* ChargePipeline;
  yield* pipeline.ingest({
    source: 'wayforpay_callback',
    idemKey: 'w4pcb:chk_cc_declined|Declined',
    externalRef: CARD_CHANGE_DECLINE_ID,
    externalUserId: null,
    amount: 30000,
    currency: 0,
    status: 'failed',
    occurredAt: new Date('2026-01-05T00:00:00Z'),
    payload: { recToken: 'new', reason: 'Insufficient funds' },
  });
  yield* runFor(2);
});

const assertCardChangeDecline = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'card_change_failed'`,
    '1',
    'a declined card change emits card_change_failed (AC-C3c)',
  );
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '1',
    'the payment stays past_due — a decline does not revive it',
  );
  await eq(
    query,
    `SELECT "recurringTokenRef" FROM payments`,
    'old',
    'the stored token is unchanged on a decline',
  );
};

const cardChangeDeclineLeavesPayment: EffectScenario = {
  name: 'card-change: a declined change leaves the past_due payment untouched (AC-C3c)',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCardChangeDecline);
      await assertCardChangeDecline(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/**
 * The revive-in-place guard (docs/28): a crypto manual-renewal prompt flips the payment to
 * PastDue, so `findActiveRecurringByExternalUser` MUST still return it — otherwise paying
 * the manual session would insert a duplicate recurring payment instead of extending. This
 * exercises the real SQL predicate against Postgres.
 */
const findExtendableMatchesPastDue: EffectScenario = {
  name: 'create-or-extend: a PastDue recurring payment is still extendable (revive-in-place)',
  run: async ({ config }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const subs = makePaymentRepo(sql);
          const created = yield* subs.insert({
            externalUserId: 'sp:pastdue',
            amount: 30000,
            currency: 0,
            method: 1, // crypto
            period: 'P1M',
            status: PaymentStatus.PastDue,
            recurring: true,
            currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
            currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
            nextPaymentDate: new Date('2026-01-01T00:00:00Z'),
            recurringTokenRef: null, // token-less → the manual-prompt path
            firstFailureAt: new Date('2026-01-01T00:00:00Z'),
            retryAttempt: 1,
          });
          const found =
            yield* subs.findActiveRecurringByExternalUser('sp:pastdue');
          assert.equal(
            Option.isSome(found),
            true,
            'a PastDue recurring payment must be extendable (else paying duplicates it)',
          );
          assert.equal(
            Option.isSome(found) ? found.value.id : null,
            created.id,
          );
        }),
      );
    } finally {
      await runtime.dispose();
    }
  },
};

/**
 * Guards against a unique-violation brick (23505): if a user somehow has BOTH an Active and
 * a PastDue recurring row, the finder must return the ACTIVE one (Active-first ordering), so
 * create-or-extend revives the already-Active row and never flips the PastDue to a SECOND
 * Active — which `payments_one_active_per_user` (migration 0014) would reject.
 */
const findPrefersActiveWhenBothExist: EffectScenario = {
  name: 'create-or-extend: prefers the Active recurring over a coexisting PastDue (no 23505 brick)',
  run: async ({ config }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const subs = makePaymentRepo(sql);
          // PastDue is inserted FIRST (older createdAt); Active SECOND (newer) — so a naive
          // "newest first" would wrongly pick the PastDue. Active-first ordering must win.
          const pastDue = yield* subs.insert({
            externalUserId: 'sp:both',
            amount: 30000,
            currency: 0,
            method: 1,
            period: 'P1M',
            status: PaymentStatus.PastDue,
            recurring: true,
            currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
            currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
            nextPaymentDate: new Date('2026-01-01T00:00:00Z'),
            recurringTokenRef: null,
            firstFailureAt: new Date('2026-01-01T00:00:00Z'),
            retryAttempt: 1,
          });
          const active = yield* subs.insert({
            externalUserId: 'sp:both',
            amount: 30000,
            currency: 0,
            method: 0,
            period: 'P1M',
            status: PaymentStatus.Active,
            recurring: true,
            currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
            currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
            nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
            recurringTokenRef: 'tok',
            firstFailureAt: null,
            retryAttempt: 0,
          });
          const found =
            yield* subs.findActiveRecurringByExternalUser('sp:both');
          assert.equal(
            Option.isSome(found) ? found.value.id : null,
            active.id,
            'must return the Active row, not the (older) PastDue one',
          );
          assert.notEqual(
            Option.isSome(found) ? found.value.id : null,
            pastDue.id,
          );
        }),
      );
    } finally {
      await runtime.dispose();
    }
  },
};

/** A PastDue (mid-retry) payment can now be cancelled: requestCancel flags it, and
 * the next scheduler tick lapses it instead of retrying the charge (no WFP call). */
const driveCancelPastDue = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:pd-cancel',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.PastDue,
    recurring: true,
    currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-07-01T00:00:00Z'), // due in the past
    recurringTokenRef: 'tok',
    firstFailureAt: new Date('2026-07-01T00:00:00Z'),
    retryAttempt: 1,
  });
  const ok = yield* subs.requestCancel(created.id);
  if (!ok) {
    return yield* Effect.die('requestCancel must accept a PastDue payment');
  }
  const outbox = yield* Outbox;
  const pipeline = yield* ChargePipeline;
  yield* scheduleTick(
    {
      subs,
      client: {
        charge: () => Effect.die('WFP charge must not run on a cancel lapse'),
      },
      ingest: pipeline.ingest,
      publish: outbox.publish,
      lapse: (sub) =>
        enqueue(sql)({
          messageType: PAYMENT_LAPSE,
          idemKey: `lapse:${sub.id}`,
          payload: { paymentId: sub.id, externalUserId: sub.externalUserId },
        }).pipe(Effect.asVoid),
      upstreamCancelled: () => Effect.succeed(false),
      cancelUpstream: () => Effect.void,
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    { intervalSeconds: 60, batchSize: 10 },
  );
  yield* runFor(2);
});

const cancelPastDueLapses: EffectScenario = {
  name: 'support: cancel a PastDue payment — next tick lapses it, no charge',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCancelPastDue);
      await assertLapse(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** A terminal RenewalFailed payment has no future scheduler tick to lapse it, so
 * cancelling it flips straight to `cancelled` inside requestCancel. */
const driveCancelRenewalFailed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:rf-cancel',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.RenewalFailed,
    recurring: true,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-02-08T00:00:00Z'),
    recurringTokenRef: 'tok',
    firstFailureAt: new Date('2026-02-01T00:00:00Z'),
    retryAttempt: 5,
  });
  const ok = yield* subs.requestCancel(created.id);
  if (!ok) {
    return yield* Effect.die(
      'requestCancel must accept a RenewalFailed payment',
    );
  }
});

const assertRenewalFailedCancelled = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '3',
    'a cancelled RenewalFailed flips straight to cancelled (no lapse tick)',
  );
  await eq(
    query,
    `SELECT ("cancelRequestedAt" IS NOT NULL)::text FROM payments`,
    'true',
    'cancelRequestedAt is stamped',
  );
};

const cancelRenewalFailedImmediate: EffectScenario = {
  name: 'support: cancelling a RenewalFailed payment flips it straight to cancelled',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCancelRenewalFailed);
      await assertRenewalFailedCancelled(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** The scheduler's pre-charge check reports the contact cancelled upstream
 * (SendPulse): cancel locally via the real cancelUpstream repo + emit
 * payment_cancelled, and NEVER call the WFP charge client (docs/23). */
const driveCancelUpstream = Effect.gen(function* () {
  yield* registerHandlers;
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const created = yield* subs.insert({
    externalUserId: 'sp:upstream-cancel',
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.Active,
    recurring: true,
    currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-07-01T00:00:00Z'), // due
    recurringTokenRef: 'tok',
    firstFailureAt: null,
    retryAttempt: 0,
  });
  void created;
  const outbox = yield* Outbox;
  yield* scheduleTick(
    {
      subs,
      client: {
        charge: () =>
          Effect.die('WFP charge must not run: contact cancelled upstream'),
      },
      ingest: (yield* ChargePipeline).ingest,
      publish: outbox.publish,
      lapse: () =>
        Effect.die('lapse unused: upstream cancel uses cancelUpstream'),
      upstreamCancelled: () => Effect.succeed(true),
      cancelUpstream: (sub, now) =>
        subs
          .cancelUpstream(sub.id)
          .pipe(
            Effect.flatMap((cancelled) =>
              cancelled
                ? outbox.publish(sinkCancelled(sub, 'sendpulse_cancelled', now))
                : Effect.void,
            ),
          ),
      createManualCheckout: () =>
        Effect.die('manual checkout unused: this payment has a token'),
    },
    { intervalSeconds: 60, batchSize: 10 },
  );
  yield* runFor(2);
});

const assertCancelUpstream = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT status::text FROM payments`,
    '3',
    'the upstream-cancelled payment is cancelled locally',
  );
  await eq(
    query,
    `SELECT ("cancelRequestedAt" IS NOT NULL)::text FROM payments`,
    'true',
    'cancelRequestedAt is stamped',
  );
  await eq(
    query,
    `SELECT count(*) FROM domain_events WHERE name = 'payment_cancelled'
       AND payload->>'reason' = 'sendpulse_cancelled'`,
    '1',
    'payment_cancelled (reason sendpulse_cancelled) emitted',
  );
  await eq(
    query,
    `SELECT count(*) FROM charge_fixations`,
    '0',
    'no WFP charge was attempted (no fixation)',
  );
};

const cancelUpstreamSkipsCharge: EffectScenario = {
  name: 'scheduler: a contact cancelled upstream is cancelled locally, never charged',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCancelUpstream);
      await assertCancelUpstream(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** The operator payments search resolves a typed name/username/phone to contact
 * ids via the contacts cache (migration 0019): findByContactName joins contacts
 * and ILIKE-matches. Verifies case-insensitivity, phone-fragment match, and that
 * a decoy contact is not returned. */
const driveNameSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const subs = makePaymentRepo(sql);
  const contacts = makeContactsRepo(sql);
  const mk = (externalUserId: string) => ({
    externalUserId,
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.Active,
    recurring: true,
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
    nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
    recurringTokenRef: 'tok',
    firstFailureAt: null,
    retryAttempt: 0,
  });
  yield* subs.insert(mk('sp:match'));
  yield* subs.insert(mk('sp:decoy'));
  yield* contacts.upsert('sp:match', {
    name: 'Олександр Петренко',
    username: 'alex_p',
    email: 'a@b.com',
    phone: '+380631112233',
  });
  yield* contacts.upsert('sp:decoy', {
    name: 'Іван Сидоренко',
    username: 'ivan',
    email: '',
    phone: '',
  });
  const only = (rows: readonly { externalUserId: string }[], id: string) =>
    rows.length === 1 && rows[0]?.externalUserId === id;
  const bySurname = yield* subs.findByContactName('петренко'); // case-insensitive
  const byUsername = yield* subs.findByContactName('alex_p');
  const byPhone = yield* subs.findByContactName('1112233');
  const byDecoy = yield* subs.findByContactName('сидоренко');
  if (
    !only(bySurname, 'sp:match') ||
    !only(byUsername, 'sp:match') ||
    !only(byPhone, 'sp:match') ||
    !only(byDecoy, 'sp:decoy')
  ) {
    return yield* Effect.die(
      'name search did not resolve to the expected contact',
    );
  }
});

const assertNameSearch = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM contacts`,
    '2',
    'both contacts were cached',
  );
};

const nameSearchResolvesContact: EffectScenario = {
  name: 'operator: payments search resolves a typed name/phone to the contact',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveNameSearch);
      await assertNameSearch(query);
    } finally {
      await runtime.dispose();
    }
  },
};

/** Payment factory for the cancelling-filter scenario. */
const filterPayment = (
  externalUserId: string,
  status: PaymentStatus,
  firstFailureAt: Date | null,
  retryAttempt: number,
) => ({
  externalUserId,
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status,
  recurring: true,
  currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-07-01T00:00:00Z'),
  recurringTokenRef: 'tok',
  firstFailureAt,
  retryAttempt,
});

/** The operator "cancelling" bucket now covers a soft-cancel on an Active OR a
 * PastDue payment (docs/24); those rows also drop out of the plain PastDue bucket. */
const driveCancellingFilter = Effect.gen(function* () {
  const subs = makePaymentRepo(yield* SqlClient.SqlClient);
  const failedAt = new Date('2026-07-01T00:00:00Z');
  const a = yield* subs.insert(
    filterPayment('sp:cf-active', PaymentStatus.Active, null, 0),
  );
  const pd = yield* subs.insert(
    filterPayment('sp:cf-pastdue', PaymentStatus.PastDue, failedAt, 1),
  );
  const pd2 = yield* subs.insert(
    filterPayment('sp:cf-pastdue2', PaymentStatus.PastDue, failedAt, 1),
  );
  yield* subs.requestCancel(a.id); // Active soft-cancel
  yield* subs.requestCancel(pd.id); // PastDue soft-cancel; pd2 stays a plain PastDue
  const inCancelling = (
    yield* subs.listAll(500, { statuses: [], cancelling: true })
  ).map((p) => p.id);
  const inPastDue = (
    yield* subs.listAll(500, {
      statuses: [PaymentStatus.PastDue],
      cancelling: false,
    })
  ).map((p) => p.id);
  const ok =
    inCancelling.includes(a.id) &&
    inCancelling.includes(pd.id) &&
    !inCancelling.includes(pd2.id) &&
    inPastDue.includes(pd2.id) &&
    !inPastDue.includes(pd.id);
  if (!ok) {
    return yield* Effect.die(
      'cancelling bucket must include Active+PastDue soft-cancels and exclude them from the PastDue bucket',
    );
  }
});

const assertCancellingFilter = async (
  query: EffectE2eContext['query'],
): Promise<void> => {
  await eq(
    query,
    `SELECT count(*) FROM payments WHERE "cancelRequestedAt" IS NOT NULL`,
    '2',
    'two soft-cancels seeded (one Active, one PastDue)',
  );
};

const cancellingBucketIncludesPastDue: EffectScenario = {
  name: 'operator: the cancelling bucket includes soft-cancelled PastDue subs',
  run: async ({ config, query }) => {
    const runtime = makeWorkerRuntime(config);
    try {
      await runtime.runPromise(driveCancellingFilter);
      await assertCancellingFilter(query);
    } finally {
      await runtime.dispose();
    }
  },
};

export const effectScenarios: readonly EffectScenario[] = [
  quarantineAndDeliver,
  findExtendableMatchesPastDue,
  findPrefersActiveWhenBothExist,
  bindReprocesses,
  pollerIngestsJournal,
  checkoutCreatesPayment,
  schedulerChargesDue,
  cancelPayment,
  softCancelLapses,
  cancelPastDueLapses,
  cancelRenewalFailedImmediate,
  cancelUpstreamSkipsCharge,
  cancellingBucketIncludesPastDue,
  nameSearchResolvesContact,
  cardChangeOwedRevives,
  cardChangeDeclineLeavesPayment,
];
