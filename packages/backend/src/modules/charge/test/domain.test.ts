import { it } from '@effect/vitest';
import {
  CheckoutSessionStatus,
  type DomainEvent,
} from '@billing-service/shared';
import { Effect, Logger, LogLevel, Option } from 'effect';
import { expect } from 'vitest';

import type { EnqueueInput } from '@/infra/queue/store.js';
import {
  type Charge,
  type Match,
  type MatchResult,
  PAYMENT_EVENT_RECEIVED,
  type RefusedCharge,
  type SettledCharge,
  type ChargeApplier,
  type ChargeMatcher,
} from '@/modules/charge/contracts.js';
import type {
  ChargeRepo,
  MatchOutcome,
  NewPayment,
  SettledOriginal,
} from '@/modules/charge/data-access.js';
import {
  boundChargeKind,
  cardChangeFailed,
  cardChangeSucceeded,
  chargeKindOf,
  handleChargeEvent,
  ingest,
  initialPaymentFailed,
  isBuyerId,
  paymentRefunded,
  quarantined,
  type RefundableOriginal,
  rebindFromPayload,
  recurringPaymentSucceeded,
  reprocessRefunded,
} from '@/modules/charge/domain.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import { makeCheckoutApplier } from '@/modules/checkout/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

const cardChangeMatch = (owed: boolean): MatchResult => ({
  matched: true,
  kind: 'card_change',
  subscriptionId: 'pay_1',
  externalUserId: 'sp:cc',
  period: 'P1M',
  method: 0,
  amountCharged: owed,
  arrears: owed,
  origin: owed ? 'card_change_arrears' : 'card_change',
});

/** The JSON-encoded `payment_event_received` payload the handler decodes. */
const encodedPayload = (idemKey: string) => ({
  source: 'test',
  idemKey,
  externalRef: 'ref-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0, // UAH
  status: 'succeeded',
  occurredAt: '1970-01-01T00:00:00.000Z',
  payload: {},
});

const decodedCharge = (idemKey: string): Charge => ({
  source: 'test',
  idemKey,
  externalRef: 'ref-1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date(0),
  payload: {},
});

/** The fake's answer to `orderSettledByAnotherCopy`: another succeeded row of the same
 * order already matched. */
const settledElsewhere = (
  rows: ReadonlyMap<string, Charge>,
  matchResults: ReadonlyMap<string, MatchOutcome>,
  externalRef: string,
  id: string,
): boolean =>
  [...rows].some(
    ([otherId, other]) =>
      otherId !== id &&
      other.externalRef === externalRef &&
      other.status === 'succeeded' &&
      matchResults.get(otherId) === 'matched',
  );

type QuarantineStatus = 'open' | 'resolved';

/** The rows the fake keeps, shared by its operations. */
interface FakeRows {
  readonly eventsById: Map<string, Charge>;
  readonly matchResults: Map<string, MatchOutcome>;
  /** `charge_fixations`, keyed on the charge as the table is: the first one wins. */
  readonly payments: Map<string, NewPayment>;
  /** Each fixation's row id, in insertion order, for the query's last tie-breaker. */
  readonly fixationIds: Map<string, number>;
  readonly quarantines: Map<string, string>;
  readonly quarantineStatus: Map<string, QuarantineStatus>;
  /** Charges whose quarantine an operator bind resolved. */
  readonly resolved: Set<string>;
  /** Event ids the outbox holds; the refund tests' publish writes it. */
  readonly stored: Set<string>;
}

/** The fake's answer to `findSettledOriginal`, ordered as the query is: the order's
 * matched success with a fixation, one fixed to a payment first, then by fixation
 * occurredAt, then fixation id. */
const originalOf = (
  rows: FakeRows,
  externalRef: string,
): Option.Option<SettledOriginal> => {
  const [first] = [...rows.eventsById]
    .flatMap(([id, row]) => {
      const fixation = rows.payments.get(id);
      return row.externalRef === externalRef &&
        row.status === 'succeeded' &&
        rows.matchResults.get(id) === 'matched' &&
        fixation !== undefined
        ? [
            {
              idemKey: row.idemKey,
              fixation,
              fixationId: rows.fixationIds.get(id) ?? 0,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(a.fixation.paymentId === null) -
          Number(b.fixation.paymentId === null) ||
        a.fixation.occurredAt.getTime() - b.fixation.occurredAt.getTime() ||
        a.fixationId - b.fixationId,
    );
  return first === undefined
    ? Option.none()
    : Option.some({
        idemKey: first.idemKey,
        externalUserId: first.fixation.externalUserId,
        paymentId: first.fixation.paymentId,
      });
};

/** The first value stored under a key wins, as an `ON CONFLICT DO NOTHING` insert. */
const setOnce = <V>(map: Map<string, V>, key: string, make: () => V): V => {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const value = make();
  map.set(key, value);
  return value;
};

/** The fake's quarantine and refund operations. A quarantine row is `open` until a bind
 * or a refund resolves it; a refund resolves only an open one, as the query does. */
const fakeQuarantineOps = (
  rows: FakeRows,
): Pick<
  ChargeRepo,
  | 'upsertQuarantine'
  | 'resolveQuarantine'
  | 'findSettledOriginal'
  | 'resolveQuarantineByRefund'
  | 'eventStored'
  | 'listQuarantinedRefunds'
> => ({
  upsertQuarantine: (id) =>
    Effect.sync(() => {
      setOnce(rows.quarantineStatus, id, () => 'open' as const);
      return setOnce(rows.quarantines, id, () => `q_${id}`);
    }),
  resolveQuarantine: (id) =>
    Effect.sync(() => {
      rows.resolved.add(id);
      rows.quarantineStatus.set(id, 'resolved');
    }),
  findSettledOriginal: (externalRef) =>
    Effect.sync(() => originalOf(rows, externalRef)),
  resolveQuarantineByRefund: (id) =>
    Effect.sync(() => {
      if (rows.quarantineStatus.get(id) === 'open') {
        rows.quarantineStatus.set(id, 'resolved');
      }
    }),
  eventStored: (id) => Effect.sync(() => rows.stored.has(id)),
  listQuarantinedRefunds: () =>
    Effect.sync(() =>
      [...rows.eventsById]
        .filter(
          ([id, charge]) =>
            charge.status === 'refunded' &&
            rows.matchResults.get(id) === 'quarantined',
        )
        // As the query orders them: by "occurredAt", then id.
        .sort(
          ([aId, a], [bId, b]) =>
            a.occurredAt.getTime() - b.occurredAt.getTime() ||
            aId.localeCompare(bId),
        )
        .map(([id, charge]) => ({ id, charge })),
    ),
});

const makeFakeRepo = () => {
  const incoming = new Map<string, string>();
  const rows: FakeRows = {
    eventsById: new Map(),
    matchResults: new Map(),
    payments: new Map(),
    fixationIds: new Map(),
    quarantines: new Map(),
    quarantineStatus: new Map(),
    resolved: new Set(),
    stored: new Set(),
  };
  const { eventsById, matchResults, payments } = rows;
  let seq = 0;

  const repo: ChargeRepo = {
    transaction: (effect) => effect,
    lockMatchResult: (id) =>
      Effect.sync(() => matchResults.get(id) ?? 'unmatched'),
    orderSettledByAnotherCopy: (externalRef, id) =>
      Effect.sync(() =>
        settledElsewhere(eventsById, matchResults, externalRef, id),
      ),
    upsertIncomingCharge: (event) =>
      Effect.sync(() => {
        let id = incoming.get(event.idemKey);
        if (id === undefined) {
          seq += 1;
          id = `inc${seq.toString()}`;
          incoming.set(event.idemKey, id);
          eventsById.set(id, event);
        }
        return id;
      }),
    setMatchResult: (id, outcome) =>
      Effect.sync(() => {
        matchResults.set(id, outcome);
      }),
    insertPayment: (input) =>
      Effect.sync(() => {
        setOnce(payments, input.incomingEventId, () => {
          rows.fixationIds.set(input.incomingEventId, rows.fixationIds.size);
          return input;
        });
      }),
    getIncomingChargeById: (id) =>
      Effect.sync(() => Option.fromNullable(eventsById.get(id))),
    listOpenQuarantine: () => Effect.succeed([]),
    getQuarantine: () => Effect.succeed(Option.none()),
    ...fakeQuarantineOps(rows),
    insertAudit: () => Effect.void,
    findChargesByPayment: () => Effect.succeed([]),
  };
  return { repo, ...rows };
};

const matcherOf =
  (result: MatchResult): ChargeMatcher =>
  () =>
    Effect.succeed(result);

/** The fields a settled result defaults: not prolonged, and no window or declaration. */
type Defaulted = 'prolonged' | 'periodStart' | 'periodEnd' | 'metadata';

/** A settled applier result; the `Defaulted` fields may be omitted. */
type Settled = Omit<SettledCharge, Defaulted> &
  Partial<Pick<SettledCharge, Defaulted>>;

const settledDefaults = {
  prolonged: false,
  periodStart: null,
  periodEnd: null,
  metadata: null,
} as const;

const applierOf =
  (result: Settled): ChargeApplier =>
  () =>
    Effect.succeed({ ...settledDefaults, ...result });

/** Applier for paths where no match occurs, so it must never be called. */
const noApplier: ChargeApplier = () =>
  Effect.die('applier called on an unmatched path');

const recordingPublish = () => {
  const events: DomainEvent[] = [];
  return {
    events,
    publish: (event: DomainEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
};

it.effect(
  'an unmatched charge is quarantined and emits unknown_payment_quarantined',
  () =>
    Effect.gen(function* () {
      const { repo, quarantines, payments } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf({ matched: false }),
        applier: noApplier,
        publish: pub.publish,
      })(encodedPayload('k1'));

      expect(payments.size).toBe(0);
      expect(quarantines.size).toBe(1);
      expect(pub.events).toHaveLength(1);
      expect(pub.events[0]?.name).toBe('unknown_payment_quarantined');
      expect(pub.events[0]?.externalUserId).toBeNull();
      expect(pub.events[0]?.id).toBe('evt_k1:quarantined');
    }),
);

it.effect(
  'a matched recurring charge records a payment and emits recurring_payment_succeeded',
  () =>
    Effect.gen(function* () {
      const { repo, payments, quarantines } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf({
          matched: true,
          kind: 'recurring',
          subscriptionId: 'sub_1',
          externalUserId: 'sp:1',
          period: 'P1M',
          method: 0,
        }),
        applier: applierOf({
          subscriptionId: 'sub_1',
          created: false,
          nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
          periodStart: new Date('2026-01-01T00:00:00Z'),
          periodEnd: new Date('2026-02-01T00:00:00Z'),
          metadata: null,
        }),
        publish: pub.publish,
      })(encodedPayload('k2'));

      expect(quarantines.size).toBe(0);
      expect(payments.size).toBe(1);
      // No payment_created when the payment already existed.
      expect(pub.events).toHaveLength(1);
      expect(pub.events[0]?.name).toBe('recurring_payment_succeeded');
      expect(pub.events[0]?.externalUserId).toBe('sp:1');
      expect(pub.events[0]?.aggregateId).toBe('sub_1');
      expect(pub.events[0]?.id).toBe('evt_k2:succeeded');
    }),
);

it.effect('a checkout first charge also emits payment_created', () =>
  Effect.gen(function* () {
    const { repo } = makeFakeRepo();
    const pub = recordingPublish();

    yield* handleChargeEvent({
      repo,
      matcher: matcherOf({
        matched: true,
        kind: 'checkout',
        subscriptionId: null,
        externalUserId: 'sp:2',
        period: 'P1M',
        // Crypto, not the default card, so the payload assertion below proves the
        // method is taken from the match instead of assumed.
        method: 1,
        recurring: true,
      }),
      applier: applierOf({
        subscriptionId: 'sub_new',
        created: true,
        nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
        periodStart: new Date('2026-01-01T00:00:00Z'),
        periodEnd: new Date('2026-02-01T00:00:00Z'),
        metadata: null,
      }),
      publish: pub.publish,
    })(encodedPayload('k7'));

    expect(pub.events.map((e) => e.name)).toEqual([
      'payment_created',
      'initial_payment_succeeded',
    ]);
    expect(pub.events.every((e) => e.aggregateId === 'sub_new')).toBe(true);
    // The new payment's method decides how it renews (a card autocharges, crypto takes
    // a manual prompt), so it travels with the amount and the period it applies to.
    const created = pub.events.find((e) => e.name === 'payment_created');
    expect(created?.payload).toEqual({
      amount: 30000,
      currency: 0,
      method: 1,
      period: 'P1M',
      // AC 21: additive; null because this checkout set no renewal terms.
      renewal: null,
      // The match carried no declaration, so the event says so explicitly rather than
      // omitting the key — a consumer reading `metadata` must not get `undefined`.
      metadata: null,
    });
  }),
);

it.effect(
  'a one-time checkout emits payment_created + one_time_purchase_succeeded',
  () =>
    Effect.gen(function* () {
      const { repo } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf({
          matched: true,
          kind: 'checkout',
          subscriptionId: null,
          externalUserId: 'sp:ot',
          period: 'P1M',
          method: 0,
          recurring: false,
        }),
        // The applier surfaces a next-charge date, but a one-time purchase never renews —
        // its success event must null it out.
        applier: applierOf({
          subscriptionId: 'pay_ot',
          created: true,
          nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
          periodStart: new Date('2026-01-01T00:00:00Z'),
          periodEnd: new Date('2026-02-01T00:00:00Z'),
          metadata: null,
        }),
        publish: pub.publish,
      })(encodedPayload('k_ot'));

      // A one-time purchase fires its OWN success event, never initial_payment_succeeded.
      expect(pub.events.map((e) => e.name)).toEqual([
        'payment_created',
        'one_time_purchase_succeeded',
      ]);
      expect(pub.events.every((e) => e.aggregateId === 'pay_ot')).toBe(true);
      expect(
        (pub.events[1]?.payload as { nextPaymentDate?: unknown })
          .nextPaymentDate,
      ).toBeNull();
    }),
);

it.effect(
  'a declined checkout charge emits initial_payment_failed (no payment, no quarantine)',
  () =>
    Effect.gen(function* () {
      const { repo, payments, quarantines } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf({
          matched: true,
          kind: 'checkout',
          subscriptionId: null,
          externalUserId: 'sp:3',
          period: 'P1M',
          method: 0,
        }),
        // A failed charge must never reach the applier (no payment is recorded).
        applier: noApplier,
        publish: pub.publish,
      })({
        ...encodedPayload('k8'),
        status: 'failed',
        payload: { reason: 'Declined' },
      });

      expect(payments.size).toBe(0);
      expect(quarantines.size).toBe(0);
      expect(pub.events).toHaveLength(1);
      expect(pub.events[0]?.name).toBe('initial_payment_failed');
      expect(pub.events[0]?.externalUserId).toBe('sp:3');
      expect(pub.events[0]?.id).toBe('evt_k8:failed');
    }),
);

it.effect(
  'ingest enqueues a payment_event_received keyed on the source idemKey',
  () =>
    Effect.gen(function* () {
      const enqueued: EnqueueInput[] = [];
      const enqueue = (input: EnqueueInput) =>
        Effect.sync(() => {
          enqueued.push(input);
          return { enqueued: true, messageId: 'm1' };
        });

      yield* ingest({ enqueue })(decodedCharge('k3'));

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.messageType).toBe(PAYMENT_EVENT_RECEIVED);
      expect(enqueued[0]?.idemKey).toBe('k3');
    }),
);

it.effect(
  'rebind records a payment, resolves the quarantine, and emits recurring_payment_succeeded',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      const pub = recordingPublish();
      const incId = yield* fake.repo.upsertIncomingCharge(decodedCharge('k9'));

      yield* rebindFromPayload({
        repo: fake.repo,
        matcher: matcherOf({ matched: false }),
        applier: noApplier,
        publish: pub.publish,
      })({
        incomingEventId: incId,
        quarantineId: 'q1',
        externalUserId: 'sp:9',
        subscriptionId: null,
        period: 'P1M',
        method: 0,
      });

      expect(fake.payments.has(incId)).toBe(true);
      expect(fake.resolved.has(incId)).toBe(true);
      expect(pub.events[0]?.name).toBe('recurring_payment_succeeded');
      expect(pub.events[0]?.externalUserId).toBe('sp:9');
      expect(pub.events[0]?.id).toBe('evt_k9:succeeded');
    }),
);

it('recurringPaymentSucceeded carries the docs/07 required payload fields', () => {
  const event = recurringPaymentSucceeded(
    decodedCharge('k4'),
    {
      matched: true,
      kind: 'recurring',
      subscriptionId: 'sub_9',
      externalUserId: 'sp:9',
      period: 'P1M',
      method: 1,
    },
    'sub_9',
    {
      nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-02-01T00:00:00Z'),
      metadata: { plan: 'half_year' },
    },
  );
  expect(event.payload).toEqual({
    amount: 30000,
    currency: 0,
    method: 1,
    period: 'P1M',
    source: 'test',
    // A recurring match is billing's own renewal order: started by the schedule.
    chargeKind: 'scheduled',
    nextPaymentDate: '2026-02-01T00:00:00.000Z',
    // The window the money bought, and the caller's own declaration echoed back.
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z',
    recurring: true,
    metadata: { plan: 'half_year' },
  });
  expect(event.aggregateId).toBe('sub_9');
});

it('initialPaymentFailed carries the decline reason and required fields', () => {
  const event = initialPaymentFailed(
    { ...decodedCharge('k6'), status: 'failed', payload: { reasonCode: 1101 } },
    {
      matched: true,
      kind: 'checkout',
      subscriptionId: null,
      externalUserId: 'sp:6',
      period: 'P1M',
      method: 0,
    },
  );
  expect(event.name).toBe('initial_payment_failed');
  // A numeric reasonCode is coerced to a string for the outgoing payload.
  expect(event.payload).toEqual({
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    reason: '1101',
    source: 'test',
  });
  expect(event.aggregateId).toBe('ref-1');
});

it('quarantined carries a null user and references the quarantine record', () => {
  const event = quarantined(decodedCharge('k5'), 'q_1', 'inc_1');
  expect(event.externalUserId).toBeNull();
  expect(event.aggregateId).toBe('q_1');
  expect(event.payload.incomingEventId).toBe('inc_1');
});

it.effect(
  'a verify card-change (not owed) emits only card_change_succeeded, no fixation',
  () =>
    Effect.gen(function* () {
      const { repo, payments } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf(cardChangeMatch(false)),
        applier: applierOf({
          subscriptionId: 'pay_1',
          created: false,
          nextPaymentDate: null,
          periodStart: null,
          periodEnd: null,
          metadata: null,
        }),
        publish: pub.publish,
      })(encodedPayload('cc1'));

      expect(payments.size).toBe(0); // no money moved → no charge fixation
      expect(pub.events.map((e) => e.name)).toEqual(['card_change_succeeded']);
      expect(pub.events[0]?.aggregateId).toBe('pay_1');
      expect(pub.events[0]?.id).toBe('evt_cc1:card_change');
    }),
);

it.effect(
  'an owed card-change emits recurring_payment_succeeded then card_change_succeeded and records a fixation',
  () =>
    Effect.gen(function* () {
      const { repo, payments } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf(cardChangeMatch(true)),
        applier: applierOf({
          subscriptionId: 'pay_1',
          created: false,
          nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
          periodStart: new Date('2026-01-01T00:00:00Z'),
          periodEnd: new Date('2026-02-01T00:00:00Z'),
          metadata: null,
        }),
        publish: pub.publish,
      })(encodedPayload('cc2'));

      expect(payments.size).toBe(1); // the collected charge is fixed
      expect(pub.events.map((e) => e.name)).toEqual([
        'recurring_payment_succeeded',
        'card_change_succeeded',
      ]);
    }),
);

it.effect(
  'a declined card-change emits only card_change_failed and never applies',
  () =>
    Effect.gen(function* () {
      const { repo, payments } = makeFakeRepo();
      const pub = recordingPublish();

      yield* handleChargeEvent({
        repo,
        matcher: matcherOf(cardChangeMatch(true)),
        applier: noApplier, // a failed card-change must not touch the payment
        publish: pub.publish,
      })({
        ...encodedPayload('cc3'),
        status: 'failed',
        payload: { reason: 'Declined' },
      });

      expect(payments.size).toBe(0);
      expect(pub.events.map((e) => e.name)).toEqual(['card_change_failed']);
      expect(pub.events[0]?.id).toBe('evt_cc3:card_change_failed');
    }),
);

it('cardChangeSucceeded/Failed carry the method and decline reason', () => {
  const ok = cardChangeSucceeded(decodedCharge('cc4'), {
    matched: true,
    kind: 'card_change',
    subscriptionId: 'pay_2',
    externalUserId: 'sp:cc',
    period: 'P1M',
    method: 1,
  });
  expect(ok.name).toBe('card_change_succeeded');
  expect(ok.payload).toEqual({ method: 1 });
  expect(ok.aggregateId).toBe('pay_2');

  const bad = cardChangeFailed(
    {
      ...decodedCharge('cc5'),
      status: 'failed',
      payload: { reason: 'Declined' },
    },
    {
      matched: true,
      kind: 'card_change',
      subscriptionId: 'pay_2',
      externalUserId: 'sp:cc',
      period: 'P1M',
      method: 1,
    },
  );
  expect(bad.name).toBe('card_change_failed');
  expect(bad.payload).toEqual({ reason: 'Declined' });
});

// ---- Prolongation events, AC 25, and settlement replay (T12–T14, T27, T30, T32, T33) ----

/** The handler deps over a fresh fake repo, with publish recording and log capture. */
const harness = (match: MatchResult, applier: ChargeApplier) => {
  const fake = makeFakeRepo();
  const pub = recordingPublish();
  const logs: string[] = [];
  const logger = Logger.make(({ logLevel, message }) => {
    logs.push(`${logLevel.label} ${String(message)}`);
  });
  const handle = handleChargeEvent({
    repo: fake.repo,
    matcher: matcherOf(match),
    applier,
    publish: pub.publish,
  });
  const run = (payload: unknown) =>
    handle(payload).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
    );
  return { ...fake, events: pub.events, logs, run };
};

const recurringCheckout = (over: Partial<Match> = {}): MatchResult => ({
  matched: true,
  kind: 'checkout',
  subscriptionId: null,
  externalUserId: 'sp:p',
  period: 'P4W',
  method: 0,
  recurring: true,
  ...over,
});

/** An applier that counts its calls and returns `result`. */
const countingApplier = (result: Settled) => {
  let calls = 0;
  const applier: ChargeApplier = () =>
    Effect.sync(() => {
      calls += 1;
      return { ...settledDefaults, ...result };
    });
  return { applier, calls: () => calls };
};

const NEXT = new Date('2026-03-01T00:00:00Z');

it.effect(
  'a prolonged checkout emits recurring_payment_succeeded only, never payment_created',
  () =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({ origin: 'prolong' }),
        applierOf({
          subscriptionId: 'sub_live',
          created: false,
          prolonged: true,
          nextPaymentDate: NEXT,
        }),
      );

      yield* h.run(encodedPayload('kp'));

      expect(h.events.map((e) => e.name)).toEqual([
        'recurring_payment_succeeded',
      ]);
      expect(h.events[0]?.aggregateId).toBe('sub_live');
      expect(h.events[0]?.payload).toMatchObject({
        period: 'P4W',
        source: 'test',
        nextPaymentDate: NEXT.toISOString(),
      });
      expect(h.payments.size).toBe(1);
      expect(h.matchResults.get('inc1')).toBe('matched');
    }),
);

it.effect(
  'a prolongation that cleared a cancel emits payment_reactivated first',
  () =>
    Effect.gen(function* () {
      const applied = countingApplier({
        subscriptionId: 'sub_live',
        created: false,
        prolonged: true,
        reactivated: true,
        nextPaymentDate: NEXT,
      });
      const h = harness(recurringCheckout(), applied.applier);

      yield* h.run(encodedPayload('kr'));
      // A queue retry of the settled charge: the matchResult lock makes it a no-op.
      yield* h.run(encodedPayload('kr'));

      expect(h.events.map((e) => e.name)).toEqual([
        'payment_reactivated',
        'recurring_payment_succeeded',
      ]);
      expect(h.events[0]?.id).toBe('evt_sub_live_reactivated_0');
      expect(h.events[0]?.aggregateId).toBe('sub_live');
      expect(applied.calls()).toBe(1);
    }),
);

it.effect('no pending cancel → no payment_reactivated', () =>
  Effect.gen(function* () {
    const h = harness(
      recurringCheckout(),
      applierOf({
        subscriptionId: 'sub_live',
        created: false,
        prolonged: true,
        reactivated: false,
        nextPaymentDate: NEXT,
      }),
    );

    yield* h.run(encodedPayload('kn'));

    expect(h.events.map((e) => e.name)).toEqual([
      'recurring_payment_succeeded',
    ]);
  }),
);

it.effect.each([
  ['prolong', 'initial_payment_succeeded'],
  ['manual_renewal', 'recurring_payment_succeeded'],
] as const)(
  'a %s session paid after its sub died → payment_created + %s on the fresh row',
  ([origin, succeeded]) =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({
          origin,
          renewalOf: 'sub_dead',
          renewal: { amount: 5000, period: 'P4W' },
        }),
        applierOf({
          subscriptionId: 'sub_fresh',
          created: true,
          nextPaymentDate: NEXT,
        }),
      );

      yield* h.run(encodedPayload(`kd_${origin}`));

      expect(h.events.map((e) => e.name)).toEqual([
        'payment_created',
        succeeded,
      ]);
      expect(h.events.every((e) => e.aggregateId === 'sub_fresh')).toBe(true);
      // AC 21: the renewal terms ride along; amount/period stay the first charge.
      expect(h.events[0]?.payload).toEqual({
        amount: 30000,
        currency: 0,
        method: 0,
        period: 'P4W',
        renewal: { amount: 5000, period: 'P4W' },
        // The match carried no declaration, so the event says so explicitly.
        metadata: null,
      });
    }),
);

it.effect(
  'a manual renewal paid while PastDue stacks and reports recurring',
  () =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({ origin: 'manual_renewal', renewalOf: 'sub_live' }),
        applierOf({
          subscriptionId: 'sub_live',
          created: false,
          prolonged: true,
          nextPaymentDate: NEXT,
        }),
      );

      yield* h.run(encodedPayload('km'));

      expect(h.events.map((e) => e.name)).toEqual([
        'recurring_payment_succeeded',
      ]);
    }),
);

it.effect(
  'a one-time checkout with a live sub keeps its own row and one-time event',
  () =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({ recurring: false, prolongOf: 'sub_live' }),
        applierOf({
          subscriptionId: 'pay_ot',
          created: true,
          nextPaymentDate: NEXT,
        }),
      );

      yield* h.run(encodedPayload('ko'));

      expect(h.events.map((e) => e.name)).toEqual([
        'payment_created',
        'one_time_purchase_succeeded',
      ]);
    }),
);

const declined = (idemKey: string) => ({
  ...encodedPayload(idemKey),
  status: 'failed',
  payload: { reason: 'Declined' },
});

/** Session and payment repos that record every write the checkout applier makes. */
const recordingRepos = () => {
  const writes: string[] = [];
  const record = (name: string) => () =>
    Effect.sync(() => {
      writes.push(name);
    }).pipe(Effect.zipRight(Effect.die(`unexpected ${name}`)));
  const sessionStatus = { chk: CheckoutSessionStatus.Pending };
  const checkout = {
    completeIfOpen: () =>
      Effect.sync(() => {
        writes.push('completeIfOpen');
        sessionStatus.chk = CheckoutSessionStatus.Completed;
        return true;
      }),
  } as unknown as CheckoutRepo;
  const payments = {
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    findActiveRecurringByExternalUser: record('findActiveRecurring'),
    lockById: record('lockById'),
    extend: record('extend'),
    insert: record('insert'),
    advanceAfterSuccess: record('advanceAfterSuccess'),
    updateToken: record('updateToken'),
    clearToken: record('clearToken'),
    setMethod: record('setMethod'),
  } as unknown as PaymentRepo;
  return { writes, sessionStatus, payments, checkout };
};

it.effect(
  'a declined prolongation emits recurring_payment_failed on the live sub, never applying',
  () =>
    Effect.gen(function* () {
      // The REAL checkout applier over recording fakes: any session or payment write it
      // made would show up here, so "the session stays payable" is observed, not assumed.
      const { writes, sessionStatus, payments, checkout } = recordingRepos();
      const h = harness(
        recurringCheckout({ origin: 'prolong', prolongOf: 'sub_live' }),
        makeCheckoutApplier(payments, checkout),
      );

      yield* h.run(declined('kf'));
      // Decline replay: settled, so a no-op.
      yield* h.run(declined('kf'));

      expect(h.events.map((e) => e.name)).toEqual(['recurring_payment_failed']);
      expect(h.events[0]?.id).toBe('evt_kf:failed');
      expect(h.events[0]?.aggregateId).toBe('sub_live');
      expect(h.events[0]?.payload).toMatchObject({ reason: 'Declined' });
      // AC 11: no session claim, no subscription write, no fixation — the session is
      // still Pending, so the next /pay releases it for another attempt.
      expect(writes).toEqual([]);
      expect(sessionStatus.chk).toBe(CheckoutSessionStatus.Pending);
      expect(h.payments.size).toBe(0);
      expect(h.matchResults.get('inc1')).toBe('matched');
    }),
);

it.effect.each([
  ['sub_dead', 'sub_dead'],
  [null, 'ref-1'],
] as const)(
  'a declined manual renewal with no live sub → recurring_payment_failed on %s',
  ([renewalOf, aggregateId]) =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({
          origin: 'manual_renewal',
          renewalOf,
          prolongOf: null,
        }),
        noApplier,
      );

      yield* h.run(declined('kmf'));

      expect(h.events.map((e) => e.name)).toEqual(['recurring_payment_failed']);
      expect(h.events[0]?.aggregateId).toBe(aggregateId);
    }),
);

it.effect(
  'a declined prolong session with no live sub keeps initial_payment_failed',
  () =>
    Effect.gen(function* () {
      const h = harness(
        recurringCheckout({
          origin: 'prolong',
          renewalOf: 'sub_dead',
          prolongOf: null,
        }),
        noApplier,
      );

      yield* h.run(declined('kpf'));

      expect(h.events.map((e) => e.name)).toEqual(['initial_payment_failed']);
      expect(h.events[0]?.aggregateId).toBe('ref-1');
    }),
);

it.effect(
  'after a decline, the same session paid with a new charge stacks once',
  () =>
    Effect.gen(function* () {
      const applied = countingApplier({
        subscriptionId: 'sub_live',
        created: false,
        prolonged: true,
        nextPaymentDate: NEXT,
      });
      const h = harness(
        recurringCheckout({ origin: 'prolong', prolongOf: 'sub_live' }),
        applied.applier,
      );

      yield* h.run(declined('k_try1'));
      yield* h.run(encodedPayload('k_try2'));
      yield* h.run(encodedPayload('k_try2'));

      expect(h.events.map((e) => e.name)).toEqual([
        'recurring_payment_failed',
        'recurring_payment_succeeded',
      ]);
      expect(applied.calls()).toBe(1);
    }),
);

it.effect('a settled 0-amount verify re-run is a no-op', () =>
  Effect.gen(function* () {
    const applied = countingApplier({
      subscriptionId: 'pay_1',
      created: false,
      nextPaymentDate: null,
    });
    const h = harness(cardChangeMatch(false), applied.applier);

    yield* h.run(encodedPayload('cv'));
    yield* h.run(encodedPayload('cv'));

    expect(h.events.map((e) => e.name)).toEqual(['card_change_succeeded']);
    expect(applied.calls()).toBe(1);
  }),
);

it.effect.each([
  [
    'a different charge on a settled checkout session',
    recurringCheckout(),
    'already_applied',
    'ERROR SETTLEMENT_ANOMALY charge: session already settled',
  ],
  [
    'a different charge on a settled card-change session',
    cardChangeMatch(true),
    'already_applied',
    'ERROR SETTLEMENT_ANOMALY charge: session already settled',
  ],
  [
    'an intro-priced charge on a live sub (Q8)',
    recurringCheckout({ renewal: { amount: 5000, period: 'P4W' } }),
    'intro_on_live',
    'ERROR SETTLEMENT_ANOMALY checkout: intro-priced payment on a live subscription',
  ],
] as const)(
  '%s is quarantined with the marker, nothing booked',
  ([, match, refused, marker]) =>
    Effect.gen(function* () {
      const refusal: RefusedCharge = { refused, subscriptionId: null };
      const h = harness(match, () => Effect.succeed(refusal));

      yield* h.run(encodedPayload('kx'));

      expect(h.events.map((e) => e.name)).toEqual([
        'unknown_payment_quarantined',
      ]);
      expect(h.payments.size).toBe(0);
      expect(h.matchResults.get('inc1')).toBe('quarantined');
      expect(h.logs).toEqual([marker]);
    }),
);

it.effect(
  'an ordinary unmatched charge quarantines with no marker, and re-runs idempotently',
  () =>
    Effect.gen(function* () {
      const h = harness({ matched: false }, noApplier);

      yield* h.run(encodedPayload('ku'));
      // 'quarantined' is not short-circuited: it re-runs and re-quarantines in place.
      yield* h.run(encodedPayload('ku'));

      expect(h.quarantines.size).toBe(1);
      expect(h.events.map((e) => e.id)).toEqual([
        'evt_ku:quarantined',
        'evt_ku:quarantined',
      ]);
      expect(h.logs).toEqual([]);
    }),
);

it.effect(
  'a failure before the final write leaves matchResult unset, so a retry settles it',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      let fail = true;
      const events: DomainEvent[] = [];
      const handle = handleChargeEvent({
        repo: fake.repo,
        matcher: matcherOf(recurringCheckout()),
        applier: applierOf({
          subscriptionId: 'sub_live',
          created: false,
          prolonged: true,
          nextPaymentDate: NEXT,
        }),
        publish: (event) =>
          fail
            ? Effect.die('outbox down')
            : Effect.sync(() => {
                events.push(event);
              }),
      });

      const first = yield* Effect.exit(handle(encodedPayload('kz')));
      expect(first._tag).toBe('Failure');
      expect(fake.matchResults.get('inc1')).toBeUndefined();

      fail = false;
      yield* handle(encodedPayload('kz'));
      expect(fake.matchResults.get('inc1')).toBe('matched');
      expect(events.map((e) => e.name)).toEqual([
        'recurring_payment_succeeded',
      ]);
    }),
);

it.effect(
  'a positive token charge is fixed and reported, crediting no time',
  () =>
    Effect.gen(function* () {
      const h = harness(
        {
          ...(cardChangeMatch(false) as Match),
          amountCharged: true,
          origin: 'card_change',
        },
        applierOf({
          subscriptionId: 'pay_1',
          created: false,
          nextPaymentDate: NEXT,
        }),
      );

      yield* h.run(encodedPayload('ct'));

      expect(h.payments.size).toBe(1);
      expect(h.events.map((e) => e.name)).toEqual([
        'recurring_payment_succeeded',
        'card_change_succeeded',
      ]);
      expect(h.matchResults.get('inc1')).toBe('matched');
    }),
);

// What started the charge, never which path settled it (owner decision 2026-10-21).
it.each([
  [
    'a renewal order billing minted (the recurring matcher)',
    'recurring',
    'scheduled',
  ],
  ['a checkout session', 'checkout', 'checkout'],
  ['a card-change session', 'card_change', 'checkout'],
] as const)('chargeKindOf: %s (%s) → %s', (_label, kind, expected) => {
  expect(chargeKindOf(kind)).toBe(expected);
});

// A bound charge matched nothing, so its orderReference is the only record of its origin.
it.each([
  [
    'billing’s own renewal order',
    'sub_3f2a9c1e-0000-4000-8000-000000000001_1767225600000',
    'scheduled',
  ],
  [
    'a WayForPay-managed regular payment',
    'ord_1712_WFPREG-48213-7',
    'scheduled',
  ],
  [
    'an invoice-style regular payment',
    'invoice_1700000000_WFPREG-48213-2',
    'scheduled',
  ],
  ['a checkout session reference', 'chk_8f1e2d', 'checkout'],
  ['an unknown provider reference', 'order-2', 'checkout'],
  ['a reference merely containing sub_ later', 'chk_sub_1', 'checkout'],
] as const)(
  'boundChargeKind: %s (%s) → %s',
  (_label, externalRef, expected) => {
    expect(boundChargeKind(externalRef)).toBe(expected);
  },
);

it.effect(
  'a bound charge reports the origin its orderReference shows: a WayForPay regular payment is scheduled',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      const pub = recordingPublish();
      const incId = yield* fake.repo.upsertIncomingCharge({
        ...decodedCharge('k10'),
        externalRef: 'ord_1712_WFPREG-48213-7',
      });

      yield* rebindFromPayload({
        repo: fake.repo,
        matcher: matcherOf({ matched: false }),
        applier: noApplier,
        publish: pub.publish,
      })({
        incomingEventId: incId,
        quarantineId: 'q10',
        externalUserId: 'sp:10',
        subscriptionId: null,
        period: 'P1M',
        method: 0,
      });

      expect(pub.events[0]?.payload).toMatchObject({ chargeKind: 'scheduled' });
    }),
);

/** The pipeline as the worker builds it, around a recurring match of order `ref-1`. */
const recurringHandler = (
  repo: ChargeRepo,
  publish: ReturnType<typeof recordingPublish>['publish'],
) =>
  handleChargeEvent({
    repo,
    matcher: matcherOf({
      matched: true,
      kind: 'recurring',
      subscriptionId: 'sub_1',
      externalUserId: 'sp:1',
      period: 'P1M',
      method: 0,
    }),
    applier: applierOf({
      subscriptionId: 'sub_1',
      created: false,
      nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
      periodStart: new Date('2026-01-01T00:00:00Z'),
      periodEnd: new Date('2026-02-01T00:00:00Z'),
      metadata: null,
    }),
    publish,
  });

// One provider order reaches the pipeline twice: the scheduler's own copy and the
// WayForPay callback, under different keys. One charge must be one payment and one event.
it.effect(
  'a second copy of an already settled scheduled order writes and publishes nothing',
  () =>
    Effect.gen(function* () {
      const { repo, payments, matchResults } = makeFakeRepo();
      const pub = recordingPublish();
      const handle = recurringHandler(repo, pub.publish);
      yield* handle(encodedPayload('w4p:ref-1|CHARGE|1700000000'));

      yield* handle(encodedPayload('w4pcb:ref-1|Approved'));

      expect(payments.size).toBe(1);
      expect(pub.events.map((e) => e.id)).toEqual([
        'evt_w4p:ref-1|CHARGE|1700000000:succeeded',
      ]);
      expect([...matchResults.values()]).toEqual(['matched', 'matched']);
    }),
);

it.effect(
  'a copy settles normally when the other copy of its order has not settled',
  () =>
    Effect.gen(function* () {
      const { repo, payments } = makeFakeRepo();
      const pub = recordingPublish();
      // The other copy is on record but unmatched: it has written nothing yet.
      yield* repo.upsertIncomingCharge(
        decodedCharge('w4p:ref-1|CHARGE|1700000000'),
      );

      yield* recurringHandler(
        repo,
        pub.publish,
      )(encodedPayload('w4pcb:ref-1|Approved'));

      expect(payments.size).toBe(1);
      expect(pub.events.map((e) => e.id)).toEqual([
        'evt_w4pcb:ref-1|Approved:succeeded',
      ]);
    }),
);

/** A WayForPay REFUND for order `ref-1`, as the callback normalizes it: no user. */
const refundCharge = (idemKey: string, over: Partial<Charge> = {}): Charge => ({
  source: 'wayforpay_callback',
  idemKey,
  externalRef: 'ref-1',
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status: 'refunded',
  occurredAt: new Date('2026-09-06T12:00:00Z'),
  payload: { reason: 'Refunded by merchant' },
  ...over,
});

const encoded = (charge: Charge) => ({
  ...charge,
  occurredAt: charge.occurredAt.toISOString(),
});

const BUYER = '64b7f0c2a1d3e4f5a6b7c8d9';
const SMOKE = 'smoke-1784463928';

interface Original {
  readonly ref?: string;
  readonly idemKey?: string;
  readonly externalUserId: string;
  readonly paymentId: string | null;
  readonly fixedAt?: Date;
  /** false: the success copy is matched without a fixation (a duplicate copy). */
  readonly fixed?: boolean;
}

/** Settle a success of an order in the fake, as the pipeline leaves it: matched, with a
 * fixation unless `fixed` is false. */
const settleOriginal = (
  fake: ReturnType<typeof makeFakeRepo>,
  original: Original,
) =>
  Effect.gen(function* () {
    const ref = original.ref ?? 'ref-1';
    const charge = {
      ...decodedCharge(original.idemKey ?? `w4pcb:${ref}|Approved`),
      externalRef: ref,
    };
    const id = yield* fake.repo.upsertIncomingCharge(charge);
    if (original.fixed !== false) {
      yield* fake.repo.insertPayment({
        incomingEventId: id,
        externalUserId: original.externalUserId,
        paymentId: original.paymentId,
        amount: charge.amount,
        currency: charge.currency,
        source: charge.source,
        occurredAt: original.fixedAt ?? charge.occurredAt,
      });
    }
    yield* fake.repo.setMatchResult(id, 'matched');
  });

const buyerPaid: Original = { externalUserId: BUYER, paymentId: 'pay_1' };

/** Pipeline deps over the fake. The publish records each event and stores its id, as the
 * outbox does; it fails for an order named in `failFor`. */
const refundDeps = (
  fake: ReturnType<typeof makeFakeRepo>,
  failFor?: string,
) => {
  const events: DomainEvent[] = [];
  const publish = (event: DomainEvent) =>
    event.name === 'payment_refunded' &&
    event.payload.orderReference === failFor
      ? Effect.die('injected publish failure')
      : Effect.sync(() => {
          events.push(event);
          fake.stored.add(event.id);
        });
  return {
    pub: { events },
    deps: {
      repo: fake.repo,
      matcher: matcherOf({ matched: false }),
      applier: noApplier,
      publish,
    },
  };
};

const refundsOf = (events: readonly DomainEvent[]) =>
  events.filter((e) => e.name === 'payment_refunded');

const expectedRefundId = 'evt_refund:ref-1';
const expectedOriginalEventId = 'evt_w4pcb:ref-1|Approved:succeeded';

it.effect(
  'a quarantined refund of a fixed success emits payment_refunded under the fixation and closes the quarantine',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      const { pub, deps } = refundDeps(fake);
      const refund = refundCharge('w4pcb:ref-1|Refunded');
      yield* handleChargeEvent(deps)(encoded(refund));
      yield* settleOriginal(fake, buyerPaid);
      const refundId = yield* fake.repo.upsertIncomingCharge(refund);

      yield* handleChargeEvent(deps)(encoded(refund));

      const refunds = refundsOf(pub.events);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({
        id: expectedRefundId,
        externalUserId: BUYER,
        aggregateId: 'pay_1',
        correlationId: 'w4pcb:ref-1|Refunded',
        payload: {
          amount: 30000,
          currency: 0,
          source: 'wayforpay_callback',
          orderReference: 'ref-1',
          originalEventId: expectedOriginalEventId,
          reason: 'Refunded by merchant',
        },
      });
      expect(fake.quarantineStatus.get(refundId)).toBe('resolved');
      expect(fake.resolved.has(refundId)).toBe(false);
      expect(fake.matchResults.get(refundId)).toBe('matched');
    }),
);

it.effect.each([
  ['the order has no settled success', null],
  [
    'the success has no fixation',
    { ...buyerPaid, fixed: false } satisfies Original,
  ],
  [
    'the success was bound without a payment',
    { externalUserId: BUYER, paymentId: null } satisfies Original,
  ],
] as const)('a refund is quarantined when %s', ([, original]) =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    const { pub, deps } = refundDeps(fake);
    if (original !== null) {
      yield* settleOriginal(fake, original);
    }
    const refund = refundCharge('w4pcb:ref-1|Refunded');

    yield* handleChargeEvent(deps)(encoded(refund));

    const refundId = yield* fake.repo.upsertIncomingCharge(refund);
    expect(pub.events.map((e) => e.name)).toEqual([
      'unknown_payment_quarantined',
    ]);
    expect(fake.matchResults.get(refundId)).toBe('quarantined');
    expect(fake.quarantineStatus.get(refundId)).toBe('open');
  }),
);

it.effect.each([
  [
    'a fixation with a payment wins over an earlier one bound without',
    [
      {
        idemKey: 'w4pcb:ref-1|Approved',
        externalUserId: BUYER,
        paymentId: null,
        fixedAt: new Date('2026-09-01T00:00:00Z'),
      },
      {
        idemKey: 'w4p:ref-1|PURCHASE|1',
        externalUserId: BUYER,
        paymentId: 'pay_later',
        fixedAt: new Date('2026-09-02T00:00:00Z'),
      },
    ],
    'pay_later',
  ],
  [
    'among fixations with a payment the earliest wins',
    [
      {
        idemKey: 'w4p:ref-1|PURCHASE|1',
        externalUserId: BUYER,
        paymentId: 'pay_later',
        fixedAt: new Date('2026-09-02T00:00:00Z'),
      },
      {
        idemKey: 'w4pcb:ref-1|Approved',
        externalUserId: BUYER,
        paymentId: 'pay_first',
        fixedAt: new Date('2026-09-01T00:00:00Z'),
      },
    ],
    'pay_first',
  ],
] as const)('the refunded original: %s', ([, originals, expected]) =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    const { pub, deps } = refundDeps(fake);
    yield* Effect.forEach(originals, (o) => settleOriginal(fake, o));

    yield* handleChargeEvent(deps)(
      encoded(refundCharge('w4pcb:ref-1|Refunded')),
    );

    expect(refundsOf(pub.events).map((e) => e.aggregateId)).toEqual([expected]);
  }),
);

it.effect('the same refund processed again emits nothing more', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    const { pub, deps } = refundDeps(fake);
    yield* settleOriginal(fake, buyerPaid);
    const refund = encoded(refundCharge('w4pcb:ref-1|Refunded'));
    yield* handleChargeEvent(deps)(refund);

    yield* handleChargeEvent(deps)(refund);

    expect(pub.events.map((e) => e.id)).toEqual([expectedRefundId]);
  }),
);

it.effect(
  "the poller's copy of a refund carries the callback copy's event id",
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      const { pub, deps } = refundDeps(fake);
      yield* settleOriginal(fake, buyerPaid);
      yield* handleChargeEvent(deps)(
        encoded(refundCharge('w4pcb:ref-1|Refunded')),
      );

      yield* handleChargeEvent(deps)(
        encoded(
          refundCharge('w4p:ref-1|REFUND|1788000000', {
            source: 'wayforpay_poller',
          }),
        ),
      );

      expect(pub.events.map((e) => [e.name, e.id])).toEqual([
        ['payment_refunded', expectedRefundId],
        ['payment_refunded', expectedRefundId],
      ]);
    }),
);

it.effect(
  'an operator bind of a refund is refused: no fixation, no success event',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      const { pub, deps } = refundDeps(fake);
      const refund = refundCharge('w4pcb:ref-1|Refunded');
      yield* handleChargeEvent(deps)(encoded(refund));
      const refundId = yield* fake.repo.upsertIncomingCharge(refund);

      yield* rebindFromPayload(deps)({
        incomingEventId: refundId,
        quarantineId: `q_${refundId}`,
        externalUserId: BUYER,
        subscriptionId: 'pay_1',
        period: 'P1M',
        method: 0,
      });

      expect(fake.payments.has(refundId)).toBe(false);
      expect(fake.quarantineStatus.get(refundId)).toBe('open');
      expect(fake.matchResults.get(refundId)).toBe('quarantined');
      expect(pub.events.map((e) => e.name)).toEqual([
        'unknown_payment_quarantined',
      ]);
    }),
);

const fixedOriginal: RefundableOriginal = {
  idemKey: 'w4pcb:ref-1|Approved',
  externalUserId: BUYER,
  paymentId: 'pay_1',
};

it('paymentRefunded carries the reversed order and success event', () => {
  const event = paymentRefunded(
    refundCharge('w4p:ref-1|REFUND|1788000000', {
      source: 'wayforpay_poller',
      amount: 12345,
      currency: 1,
      payload: { reasonCode: 1100 },
    }),
    fixedOriginal,
  );

  expect(event).toEqual({
    id: expectedRefundId,
    name: 'payment_refunded',
    occurredAt: new Date('2026-09-06T12:00:00Z'),
    correlationId: 'w4p:ref-1|REFUND|1788000000',
    externalUserId: BUYER,
    aggregateId: 'pay_1',
    payload: {
      amount: 12345,
      currency: 1,
      source: 'wayforpay_poller',
      orderReference: 'ref-1',
      originalEventId: expectedOriginalEventId,
      reason: '1100',
    },
  });
});

it.each([
  ['a reason string', { reason: 'Refund', reasonCode: 1100 }, 'Refund'],
  ['an empty reason with a code', { reason: '', reasonCode: 1100 }, '1100'],
  ['an empty reason with an empty code', { reason: '', reasonCode: '' }, null],
  ['no reason at all', {}, null],
] as const)('paymentRefunded reason from %s', (_, payload, expected) => {
  const event = paymentRefunded(
    refundCharge('k', { payload: { ...payload } }),
    fixedOriginal,
  );

  expect(event.payload.reason ?? null).toBe(expected);
});

it.each([
  ['a zero refund passes through', 0, 0],
  ['a negative provider amount is sent as its magnitude', -30000, 30000],
] as const)('paymentRefunded amount: %s', (_, amount, expected) => {
  const event = paymentRefunded(refundCharge('k', { amount }), fixedOriginal);

  expect(event.payload.amount).toBe(expected);
});

it.each([
  ['a bot user id', '64b7f0c2a1d3e4f5a6b7c8d9', true],
  ['a calibration-site UUID', 'e05bbe93-1c2d-4e5f-8a9b-0c1d2e3f4a5b', true],
  ['a smoke-test id', SMOKE, false],
  ['a bot id one character short', '64b7f0c2a1d3e4f5a6b7c8d', false],
  ['a prefixed id', 'sp:42', false],
] as const)('isBuyerId: %s → %s', (_, id, expected) => {
  expect(isBuyerId(id)).toBe(expected);
});

/** Quarantine one refund per order, as the pipeline did before it knew refunds. */
const quarantineRefunds = (
  fake: ReturnType<typeof makeFakeRepo>,
  charges: readonly Charge[],
) =>
  Effect.forEach(
    charges,
    (charge) => handleChargeEvent(refundDeps(fake).deps)(encoded(charge)),
    { discard: true },
  );

const emptyReport = {
  selected: 0,
  unresolved: 0,
  skipped: 0,
  emitted: 0,
  duplicate: 0,
  failed: 0,
};

it.effect(
  'the refund backfill classifies each quarantined refund by what its settlement did',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo();
      yield* quarantineRefunds(fake, [
        refundCharge('w4pcb:ref-1|Refunded'),
        refundCharge('w4p:ref-1|REFUND|1788000000', {
          source: 'wayforpay_poller',
        }),
        refundCharge('w4pcb:ref-2|Refunded', { externalRef: 'ref-2' }),
        refundCharge('w4pcb:smoke|Refunded', { externalRef: 'smoke' }),
        refundCharge('w4pcb:smoke-u|Refunded', { externalRef: 'smoke-u' }),
      ]);
      yield* settleOriginal(fake, buyerPaid);
      yield* settleOriginal(fake, {
        ref: 'smoke',
        externalUserId: SMOKE,
        paymentId: 'pay_smoke',
      });
      // D11 before the buyer check: an unpaid original is unresolved, whoever owns it.
      yield* settleOriginal(fake, {
        ref: 'smoke-u',
        externalUserId: SMOKE,
        paymentId: null,
      });
      const { pub, deps } = refundDeps(fake);

      const report = yield* reprocessRefunded(deps);

      expect(report).toEqual({
        selected: 5,
        emitted: 1,
        duplicate: 1,
        skipped: 1,
        unresolved: 2,
        failed: 0,
      });
      expect(refundsOf(pub.events).map((e) => e.id)).toEqual([
        expectedRefundId,
        expectedRefundId,
      ]);
    }),
);

it.effect('a skipped refund is left quarantined and untouched', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    const refund = refundCharge('w4pcb:smoke|Refunded', {
      externalRef: 'smoke',
    });
    yield* quarantineRefunds(fake, [refund]);
    yield* settleOriginal(fake, {
      ref: 'smoke',
      externalUserId: SMOKE,
      paymentId: 'pay_smoke',
    });
    const refundId = yield* fake.repo.upsertIncomingCharge(refund);
    const { pub, deps } = refundDeps(fake);

    yield* reprocessRefunded(deps);

    expect(pub.events).toEqual([]);
    expect(fake.matchResults.get(refundId)).toBe('quarantined');
    expect(fake.quarantineStatus.get(refundId)).toBe('open');
  }),
);

it.effect('the refund backfill goes on after a failed row', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    yield* quarantineRefunds(fake, [
      refundCharge('w4pcb:bad|Refunded', { externalRef: 'bad' }),
      refundCharge('w4pcb:ref-1|Refunded'),
    ]);
    yield* settleOriginal(fake, { ...buyerPaid, ref: 'bad' });
    yield* settleOriginal(fake, buyerPaid);
    const { pub, deps } = refundDeps(fake, 'bad');

    const report = yield* reprocessRefunded(deps).pipe(
      Logger.withMinimumLogLevel(LogLevel.None),
    );

    expect(report).toEqual({
      ...emptyReport,
      selected: 2,
      emitted: 1,
      failed: 1,
    });
    expect(refundsOf(pub.events).map((e) => e.id)).toEqual([expectedRefundId]);
  }),
);

it.effect('a second backfill run selects only what stayed quarantined', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo();
    yield* quarantineRefunds(fake, [refundCharge('w4pcb:ref-1|Refunded')]);
    yield* settleOriginal(fake, buyerPaid);
    yield* reprocessRefunded(refundDeps(fake).deps);
    const second = refundDeps(fake);

    const report = yield* reprocessRefunded(second.deps);

    expect(report).toEqual(emptyReport);
    expect(second.pub.events).toEqual([]);
  }),
);
