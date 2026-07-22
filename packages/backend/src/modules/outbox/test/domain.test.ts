import { it } from '@effect/vitest';
import type { DomainEvent } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import {
  SinkError,
  type SinkConnector,
  type SinksService,
} from '@/infra/sinks.js';
import type {
  DeliveryWithEvent,
  OutboxRepo,
} from '@/modules/outbox/data-access.js';
import { deliverEvent, publish } from '@/modules/outbox/domain.js';

const event = (id: string): DomainEvent => ({
  id,
  name: 'payment_succeeded',
  occurredAt: new Date(0),
  correlationId: 'corr-1',
  externalUserId: 'sendpulse:123',
  aggregateId: 'sub_1',
  payload: {
    amount: 30000,
    currency: 0,
    method: 0,
    period: 'P1M',
    source: 'test',
  },
});

interface DeliveryState {
  eventId: string;
  sink: string;
  status: 'pending' | 'delivered' | 'failed';
}

/** In-memory OutboxRepo double that records what the domain asked it to do. */
const makeFakeRepo = () => {
  const events = new Set<string>();
  const deliveries = new Map<string, DeliveryState>();
  const eventsById = new Map<string, DomainEvent>();
  let seq = 0;

  const repo: OutboxRepo = {
    transaction: (effect) => effect,
    insertEvent: (e) =>
      Effect.sync(() => {
        eventsById.set(e.id, e);
        if (events.has(e.id)) return false;
        events.add(e.id);
        return true;
      }),
    insertDelivery: (eventId, sink) =>
      Effect.sync(() => {
        seq += 1;
        const id = `d${seq.toString()}`;
        deliveries.set(id, { eventId, sink, status: 'pending' });
        return id;
      }),
    getDeliveryWithEvent: (deliveryId) =>
      Effect.sync(() => {
        const d = deliveries.get(deliveryId);
        const e = d ? eventsById.get(d.eventId) : undefined;
        return d && e
          ? Option.some<DeliveryWithEvent>({
              deliveryId,
              sink: d.sink,
              status: d.status,
              event: e,
            })
          : Option.none();
      }),
    markDelivered: (deliveryId) =>
      Effect.sync(() => {
        const d = deliveries.get(deliveryId);
        if (d) d.status = 'delivered';
      }),
    markFailed: (deliveryId) =>
      Effect.sync(() => {
        const d = deliveries.get(deliveryId);
        if (d) d.status = 'failed';
      }),
    listByStatus: () => Effect.succeed([]),
  };
  return { repo, deliveries, eventsById };
};

const sinksOf = (...sinks: readonly SinkConnector[]): SinksService => ({
  all: () => Effect.succeed(sinks),
});

const successSink: SinkConnector = { name: 'sendpulse', deliver: () => Effect.void };
const failSink: SinkConnector = {
  name: 'sendpulse',
  deliver: () =>
    Effect.fail(new SinkError({ sink: 'sendpulse', reason: 'boom' })),
};

it.effect('publish stores the event and enqueues one delivery per sink', () =>
  Effect.gen(function* () {
    const { repo, deliveries } = makeFakeRepo();
    const enqueued: string[] = [];
    const enqueue = (input: { readonly idemKey: string }) =>
      Effect.sync(() => {
        enqueued.push(input.idemKey);
        return { enqueued: true, messageId: input.idemKey };
      });

    yield* publish({ repo, sinks: sinksOf(successSink), enqueue })(
      event('evt_1'),
    );

    expect(deliveries.size).toBe(1);
    expect(enqueued).toHaveLength(1);
    // idemKey is the delivery id, so a replay dedupes at the queue.
    expect(enqueued[0]).toBe([...deliveries.keys()][0]);
  }),
);

it.effect(
  'publish is idempotent — a second publish of the same id is a no-op',
  () =>
    Effect.gen(function* () {
      const { repo, deliveries } = makeFakeRepo();
      const enqueued: string[] = [];
      const enqueue = (input: { readonly idemKey: string }) =>
        Effect.sync(() => {
          enqueued.push(input.idemKey);
          return { enqueued: true, messageId: input.idemKey };
        });
      const run = publish({ repo, sinks: sinksOf(successSink), enqueue });

      yield* run(event('evt_1'));
      yield* run(event('evt_1'));

      expect(deliveries.size).toBe(1);
      expect(enqueued).toHaveLength(1);
    }),
);

it.effect('deliverEvent marks delivered when the sink succeeds', () =>
  Effect.gen(function* () {
    const { repo, deliveries, eventsById } = makeFakeRepo();
    eventsById.set('evt_1', event('evt_1'));
    deliveries.set('d1', {
      eventId: 'evt_1',
      sink: 'sendpulse',
      status: 'pending',
    });

    yield* deliverEvent({ repo, sinks: sinksOf(successSink) })('d1');

    expect(deliveries.get('d1')?.status).toBe('delivered');
  }),
);

it.effect(
  'deliverEvent records failure and re-fails so the queue retries',
  () =>
    Effect.gen(function* () {
      const { repo, deliveries, eventsById } = makeFakeRepo();
      eventsById.set('evt_1', event('evt_1'));
      deliveries.set('d1', {
        eventId: 'evt_1',
        sink: 'sendpulse',
        status: 'pending',
      });

      const error = yield* deliverEvent({ repo, sinks: sinksOf(failSink) })(
        'd1',
      ).pipe(Effect.flip);

      expect(error._tag).toBe('SinkError');
      expect(deliveries.get('d1')?.status).toBe('failed');
    }),
);

it.effect('deliverEvent is a no-op when already delivered', () =>
  Effect.gen(function* () {
    const { repo, deliveries, eventsById } = makeFakeRepo();
    eventsById.set('evt_1', event('evt_1'));
    deliveries.set('d1', {
      eventId: 'evt_1',
      sink: 'sendpulse',
      status: 'delivered',
    });
    let called = false;
    const spySink: SinkConnector = {
      name: 'sendpulse',
      deliver: () =>
        Effect.sync(() => {
          called = true;
        }),
    };

    yield* deliverEvent({ repo, sinks: sinksOf(spySink) })('d1');

    expect(called).toBe(false);
  }),
);
