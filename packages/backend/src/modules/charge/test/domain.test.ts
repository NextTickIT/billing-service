import { it } from '@effect/vitest';
import type { DomainEvent } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { EnqueueInput } from '@/infra/queue/store.js';
import {
  type AppliedCharge,
  type Charge,
  type MatchResult,
  PAYMENT_EVENT_RECEIVED,
  type ChargeApplier,
  type ChargeMatcher,
} from '@/modules/charge/contracts.js';
import type { ChargeRepo } from '@/modules/charge/data-access.js';
import {
  handleChargeEvent,
  ingest,
  paymentSucceeded,
  quarantined,
  rebindFromPayload,
} from '@/modules/charge/domain.js';

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

const makeFakeRepo = () => {
  const incoming = new Map<string, string>();
  const eventsById = new Map<string, Charge>();
  const payments = new Set<string>();
  const quarantines = new Map<string, string>();
  const matchResults = new Map<string, string>();
  const resolved = new Set<string>();
  let seq = 0;

  const repo: ChargeRepo = {
    transaction: (effect) => effect,
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
        payments.add(input.incomingEventId);
      }),
    upsertQuarantine: (incomingEventId) =>
      Effect.sync(() => {
        let q = quarantines.get(incomingEventId);
        if (q === undefined) {
          q = `q_${incomingEventId}`;
          quarantines.set(incomingEventId, q);
        }
        return q;
      }),
    getIncomingChargeById: (id) =>
      Effect.sync(() => Option.fromNullable(eventsById.get(id))),
    listOpenQuarantine: () => Effect.succeed([]),
    getQuarantine: () => Effect.succeed(Option.none()),
    resolveQuarantine: (incomingEventId) =>
      Effect.sync(() => {
        resolved.add(incomingEventId);
      }),
    insertAudit: () => Effect.void,
  };
  return { repo, payments, quarantines, matchResults, resolved };
};

const matcherOf =
  (result: MatchResult): ChargeMatcher =>
  () =>
    Effect.succeed(result);

const applierOf =
  (result: AppliedCharge): ChargeApplier =>
  () =>
    Effect.succeed(result);

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

it.effect('a matched charge records a payment and emits payment_succeeded', () =>
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
      applier: applierOf({ subscriptionId: 'sub_1', created: false }),
      publish: pub.publish,
    })(encodedPayload('k2'));

    expect(quarantines.size).toBe(0);
    expect(payments.size).toBe(1);
    // No subscription_created when the subscription already existed.
    expect(pub.events).toHaveLength(1);
    expect(pub.events[0]?.name).toBe('payment_succeeded');
    expect(pub.events[0]?.externalUserId).toBe('sp:1');
    expect(pub.events[0]?.aggregateId).toBe('sub_1');
    expect(pub.events[0]?.id).toBe('evt_k2:succeeded');
  }),
);

it.effect('a checkout first charge also emits subscription_created', () =>
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
        method: 0,
      }),
      applier: applierOf({ subscriptionId: 'sub_new', created: true }),
      publish: pub.publish,
    })(encodedPayload('k7'));

    expect(pub.events.map((e) => e.name)).toEqual([
      'subscription_created',
      'payment_succeeded',
    ]);
    expect(pub.events.every((e) => e.aggregateId === 'sub_new')).toBe(true);
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
  'rebind records a payment, resolves the quarantine, and emits payment_succeeded',
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
      expect(pub.events[0]?.name).toBe('payment_succeeded');
      expect(pub.events[0]?.externalUserId).toBe('sp:9');
      expect(pub.events[0]?.id).toBe('evt_k9:succeeded');
    }),
);

it('paymentSucceeded carries the docs/07 required payload fields', () => {
  const event = paymentSucceeded(
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
  );
  expect(event.payload).toEqual({
    amount: 30000,
    currency: 0,
    method: 1,
    period: 'P1M',
    source: 'test',
  });
  expect(event.aggregateId).toBe('sub_9');
});

it('quarantined carries a null user and references the quarantine record', () => {
  const event = quarantined(decodedCharge('k5'), 'q_1', 'inc_1');
  expect(event.externalUserId).toBeNull();
  expect(event.aggregateId).toBe('q_1');
  expect(event.payload.incomingEventId).toBe('inc_1');
});
