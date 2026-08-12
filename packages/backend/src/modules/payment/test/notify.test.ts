import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import {
  cancelLapsed,
  paymentDeferred,
  paymentReactivated,
} from '@/modules/payment/cancel.js';
import type {
  DeferNotify,
  LapseNotify,
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

const lapseNotify: LapseNotify = {
  paymentId: 'pay_abc',
  externalUserId: 'sp:42',
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
    expect(e1.id).toBe(`evt_pay_abc_reactivated_${reactivateNotify.at.toString()}`);
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
    const event = cancelLapsed(lapseNotify, now);

    expect(event.name).toBe('renewal_failed');
    expect(event.externalUserId).toBe('sp:42');
    expect(event.aggregateId).toBe('pay_abc');
    expect(event.correlationId).toBe('pay_abc');
    expect(event.payload).toEqual({ reason: 'cancelled' });
    expect(event.occurredAt).toBe(now);
  }),
);

it.effect('cancelLapsed: id is deterministic (one lapse per payment)', () =>
  Effect.sync(() => {
    const e1 = cancelLapsed(lapseNotify, now);
    const e2 = cancelLapsed(lapseNotify, new Date('2026-01-01'));

    expect(e1.id).toBe(e2.id);
    expect(e1.id).toBe('evt_pay_abc_cancel_lapsed');
  }),
);
