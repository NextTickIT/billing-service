import { it } from '@effect/vitest';
import type { DomainEvent } from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import {
  cancelLapsed,
  lapseNotify,
  methodChanged,
  methodChangeNotify,
  paymentDeferred,
  paymentReactivated,
} from '@/modules/payment/cancel.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import type {
  DeferNotify,
  LapseNotify,
  MethodChangeNotify,
  ReactivateNotify,
} from '@/modules/payment/contracts.js';

const now = new Date('2026-08-12T10:00:00Z');

const reactivateNotify: ReactivateNotify = {
  paymentId: 'pay_abc',
  externalUserId: 'sp:42',
  at: 1700000000,
};

const deferNotify: DeferNotify = {
  paymentId: 'pay_abc',
  externalUserId: 'sp:42',
  newPeriodEnd: '2026-09-12',
  days: 30,
  at: 1700000001,
};

const lapsePayload: LapseNotify = {
  paymentId: 'pay_abc',
  externalUserId: 'sp:42',
  cancelRequestedAt: '2026-01-01T00:00:00.000Z',
};

const methodChangeNotifyPayload: MethodChangeNotify = {
  paymentId: 'pay_abc',
  externalUserId: 'sp:42',
  method: 1,
  at: 1700000002,
};

const recordingPublish = () => {
  const events: DomainEvent[] = [];
  const publish = (event: DomainEvent): Effect.Effect<void> =>
    Effect.sync(() => {
      events.push(event);
    });
  return { events, publish };
};

it.effect('paymentReactivated: produces correct name and payload', () =>
  Effect.sync(() => {
    const event = paymentReactivated(reactivateNotify, now);

    expect(event.name).toBe('payment_reactivated');
    expect(event.externalUserId).toBe('sp:42');
    expect(event.aggregateId).toBe('pay_abc');
    expect(event.correlationId).toBe('pay_abc');
    expect(event.payload).toEqual({});
    expect(event.occurredAt).toBe(now);
  }),
);

it.effect('paymentReactivated: id is deterministic from paymentId and at', () =>
  Effect.sync(() => {
    const e1 = paymentReactivated(reactivateNotify, now);
    const e2 = paymentReactivated(reactivateNotify, new Date('2026-01-01'));

    // id encodes paymentId and at — same input same id regardless of now
    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe(
      `evt_pay_abc_reactivated_${reactivateNotify.at.toString()}`,
    );
  }),
);

it.effect('paymentDeferred: produces correct name and payload', () =>
  Effect.sync(() => {
    const event = paymentDeferred(deferNotify, now);

    expect(event.name).toBe('payment_deferred');
    expect(event.externalUserId).toBe('sp:42');
    expect(event.aggregateId).toBe('pay_abc');
    expect(event.correlationId).toBe('pay_abc');
    expect(event.payload).toEqual({ newPeriodEnd: '2026-09-12', days: 30 });
    expect(event.occurredAt).toBe(now);
  }),
);

it.effect('paymentDeferred: id is deterministic from paymentId and at', () =>
  Effect.sync(() => {
    const e1 = paymentDeferred(deferNotify, now);
    const e2 = paymentDeferred(deferNotify, new Date('2026-01-01'));

    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe(`evt_pay_abc_deferred_${deferNotify.at.toString()}`);
  }),
);

it.effect('cancelLapsed: produces renewal_failed with reason cancelled', () =>
  Effect.sync(() => {
    const event = cancelLapsed(lapsePayload, now);

    expect(event.name).toBe('renewal_failed');
    expect(event.externalUserId).toBe('sp:42');
    expect(event.aggregateId).toBe('pay_abc');
    expect(event.correlationId).toBe('pay_abc');
    expect(event.payload).toEqual({ reason: 'cancelled' });
    expect(event.occurredAt).toBe(now);
  }),
);

it.effect('cancelLapsed: one event per CANCELLATION, not per payment', () =>
  Effect.sync(() => {
    // Redelivery of the same lapse dedupes...
    const e1 = cancelLapsed(lapsePayload, now);
    const e2 = cancelLapsed(lapsePayload, new Date('2026-01-01'));
    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe('evt_pay_abc_cancel_lapsed_2026-01-01T00:00:00.000Z');

    // ...but a payment cancelled, reactivated and cancelled again lapses twice, and
    // both lapses must be reported. Keying on the payment alone dropped the second.
    const second = cancelLapsed(
      { ...lapsePayload, cancelRequestedAt: '2026-06-01T00:00:00.000Z' },
      now,
    );
    expect(second.id).not.toBe(e1.id);
  }),
);

it.effect('methodChanged: produces correct name and payload', () =>
  Effect.sync(() => {
    const event = methodChanged(methodChangeNotifyPayload, now);

    expect(event.name).toBe('method_changed');
    expect(event.externalUserId).toBe('sp:42');
    expect(event.aggregateId).toBe('pay_abc');
    expect(event.correlationId).toBe('pay_abc');
    expect(event.payload).toEqual({ method: 1 });
    expect(event.occurredAt).toBe(now);
  }),
);

it.effect('methodChanged: id is deterministic from paymentId and at', () =>
  Effect.sync(() => {
    const e1 = methodChanged(methodChangeNotifyPayload, now);
    const e2 = methodChanged(methodChangeNotifyPayload, new Date('2026-01-01'));

    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe(
      `evt_pay_abc_method_changed_${methodChangeNotifyPayload.at.toString()}`,
    );
  }),
);

it.effect(
  'methodChangeNotify decodes the payload and publishes the event',
  () =>
    Effect.gen(function* () {
      const pub = recordingPublish();

      yield* methodChangeNotify(pub.publish)(methodChangeNotifyPayload);

      expect(pub.events).toHaveLength(1);
      expect(pub.events[0]?.name).toBe('method_changed');
      expect(pub.events[0]?.externalUserId).toBe('sp:42');
    }),
);

/** A repo whose lapse either flipped the row or found it already reactivated. */
const repoThatLapsed = (lapsed: boolean): PaymentRepo =>
  ({
    markCancelledLapsed: () => Effect.succeed(lapsed),
  }) as unknown as PaymentRepo;

const collect = () => {
  const events: DomainEvent[] = [];
  return {
    events,
    publish: (e: DomainEvent): Effect.Effect<void> =>
      Effect.sync(() => {
        events.push(e);
      }),
  };
};

it.effect('lapseNotify announces a lapse it actually performed', () =>
  Effect.gen(function* () {
    const pub = collect();
    yield* lapseNotify(
      repoThatLapsed(true),
      pub.publish,
    )({
      paymentId: 'pay_abc',
      externalUserId: 'sp:42',
      cancelRequestedAt: '2026-01-01T00:00:00.000Z',
      metadata: null,
    });
    expect(pub.events).toHaveLength(1);
    expect(pub.events[0]?.name).toBe('renewal_failed');
  }),
);

it.effect('lapseNotify stays silent when a reactivation won the race', () =>
  Effect.gen(function* () {
    // The buyer reactivated inside the grace window, so `cancelRequestedAt` was cleared
    // between the scheduler enqueuing and this handler: the UPDATE matches nothing.
    // Announcing anyway told SendPulse a LIVE subscriber had lapsed, which tags the
    // contact and makes the pre-charge tag check refuse to bill them — the customer
    // silently stops being charged.
    const pub = collect();
    yield* lapseNotify(
      repoThatLapsed(false),
      pub.publish,
    )({
      paymentId: 'pay_abc',
      externalUserId: 'sp:42',
      cancelRequestedAt: '2026-01-01T00:00:00.000Z',
      metadata: null,
    });
    expect(pub.events).toHaveLength(0);
  }),
);
