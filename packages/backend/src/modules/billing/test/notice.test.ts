import { it } from '@effect/vitest';
import {
  type DomainEvent,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import {
  scheduleTick,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';

const die = () => Effect.die('unused on the notice path');

const sub = (over: Partial<Payment> = {}): Payment =>
  ({
    id: 'sub-1',
    externalUserId: 'sp:1',
    amount: 5000,
    currency: 1,
    method: 0,
    period: 'P1M',
    status: PaymentStatus.Active,
    recurring: true,
    nextPaymentDate: new Date('2026-10-02T09:00:00.000Z'),
    recurringTokenRef: 'tok_1',
    firstFailureAt: null,
    retryAttempt: 0,
    cancelRequestedAt: null,
    currentPeriodStart: new Date('2026-09-02T09:00:00.000Z'),
    currentPeriodEnd: new Date('2026-10-02T09:00:00.000Z'),
    createdAt: new Date('2026-09-02T09:00:00.000Z'),
    updatedAt: new Date('2026-09-02T09:00:00.000Z'),
    ...over,
  }) as Payment;

/** Nothing is due to charge; the tick exists only to run the notice sweep. */
const deps = (
  upcoming: Record<number, readonly Payment[]>,
  published: DomainEvent[],
): SchedulerDeps =>
  ({
    subs: {
      findDue: () => Effect.succeed([]),
      findUpcomingForNotice: (days: number) =>
        Effect.succeed(upcoming[days] ?? []),
    } as unknown as PaymentRepo,
    client: { charge: die },
    ingest: die,
    publish: (event: DomainEvent) =>
      Effect.sync(() => {
        published.push(event);
      }),
    lapse: die,
    upstreamCancelled: () => Effect.succeed(false),
    cancelUpstream: die,
    createManualCheckout: die,
  }) as unknown as SchedulerDeps;

const cfg = (days: readonly number[]) => ({
  intervalSeconds: 60,
  batchSize: 10,
  upcomingChargeNoticeDays: days,
});

it.effect('announces a charge once per configured offset', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const s = sub();
    yield* scheduleTick(deps({ 3: [s], 1: [s] }, published), cfg([3, 1]));

    expect(published).toHaveLength(2);
    expect(published.map((e) => e.name)).toEqual([
      'upcoming_charge',
      'upcoming_charge',
    ]);
    const notices = published.filter((e) => e.name === 'upcoming_charge');
    expect(notices.map((e) => e.payload.noticeDays)).toEqual([3, 1]);
  }),
);

it.effect('carries the charge date, amount and period the customer needs', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub()] }, published), cfg([3]));

    const notice = published.find((e) => e.name === 'upcoming_charge');
    expect(notice?.payload).toEqual({
      paymentId: 'sub-1',
      amount: 5000,
      currency: 1,
      method: 0,
      period: 'P1M',
      chargeDate: '2026-10-02T09:00:00.000Z',
      noticeDays: 3,
    });
    // The event stays canonical — rendering is the sink's job, so no *_formatted here.
    expect(Object.keys(notice?.payload ?? {})).not.toContain(
      'chargeDate_formatted',
    );
  }),
);

it.effect('the notice carries the method of the payment, not a default', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub({ method: 1 })] }, published), cfg([3]));

    // What is coming differs by method: a card payment takes itself, a crypto one is a
    // payment the customer has to make. A notice that can't tell them apart can't be
    // worded correctly, so the method comes off the payment rather than being assumed.
    const notice = published.find((e) => e.name === 'upcoming_charge');
    expect(notice?.payload.method).toBe(1);
  }),
);

it.effect('the id pins payment, due date and offset, so a re-run dedupes', () =>
  Effect.gen(function* () {
    const first: DomainEvent[] = [];
    const second: DomainEvent[] = [];
    const s = sub();
    yield* scheduleTick(deps({ 3: [s] }, first), cfg([3]));
    yield* scheduleTick(deps({ 3: [s] }, second), cfg([3]));

    // Same id on every tick — the outbox's ON CONFLICT (id) DO NOTHING is what makes
    // that exactly-once; a 5-minute tick must not mean a notice every 5 minutes.
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(first[0]?.id).toContain('_upcoming_');
    expect(first[0]?.id).toContain('_3');
  }),
);

it.effect('a moved due date is a different notice, not a suppressed one', () =>
  Effect.gen(function* () {
    const a: DomainEvent[] = [];
    const b: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub()] }, a), cfg([3]));
    yield* scheduleTick(
      deps(
        { 3: [sub({ nextPaymentDate: new Date('2026-11-02T09:00:00.000Z') })] },
        b,
      ),
      cfg([3]),
    );

    expect(a[0]?.id).not.toBe(b[0]?.id);
  }),
);

it.effect('the two offsets are distinct events, not one deduped away', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const s = sub();
    yield* scheduleTick(deps({ 3: [s], 1: [s] }, published), cfg([3, 1]));

    expect(new Set(published.map((e) => e.id)).size).toBe(2);
  }),
);

it.effect('no configured offsets means no sweep at all', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub()] }, published), cfg([]));

    expect(published).toHaveLength(0);
  }),
);

it.effect('one bad notice does not cost the others theirs', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const base = deps(
      { 3: [sub({ id: 'bad' }), sub({ id: 'good' })] },
      published,
    );
    const flaky: SchedulerDeps = {
      ...base,
      publish: (event: DomainEvent) =>
        event.aggregateId === 'bad'
          ? Effect.fail(new Error('boom') as never)
          : Effect.sync(() => {
              published.push(event);
            }),
    };

    yield* scheduleTick(flaky, cfg([3]));

    expect(published.map((e) => e.aggregateId)).toEqual(['good']);
  }),
);
