import { it } from '@effect/vitest';
import {
  type DomainEvent,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { SqlError } from '@effect/sql';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { NO_PAY_NOW, type PayNowLink } from '@/modules/billing/events.js';
import {
  scheduleTick,
  type SchedulerDeps,
} from '@/modules/billing/scheduler.js';

const die = () => Effect.die('unused on the notice path');

const LINK: PayNowLink = {
  checkoutUrl: 'https://bill.example/checkout/chk_1',
  cycleOptions: [1, 3, 6],
};

const sub = (over: Partial<Payment> = {}): Payment => ({
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
  metadata: null,
  currentPeriodStart: new Date('2026-09-02T09:00:00.000Z'),
  currentPeriodEnd: new Date('2026-10-02T09:00:00.000Z'),
  createdAt: new Date('2026-09-02T09:00:00.000Z'),
  updatedAt: new Date('2026-09-02T09:00:00.000Z'),
  ...over,
});

/** Nothing is due to charge; the tick exists only to run the notice sweep. */
const deps = (
  upcoming: Record<number, readonly Payment[]>,
  published: DomainEvent[],
  mintPayNow: SchedulerDeps['mintPayNow'] = () => Effect.succeed(LINK),
): SchedulerDeps =>
  ({
    subs: {
      findDue: () => Effect.succeed([]),
      // Mirrors the SQL's `"nextPaymentDate" <= "currentPeriodEnd"`: a sub the near-due
      // guard deferred is never noticed again for the deferred date.
      findUpcomingForNotice: (days: number) =>
        Effect.succeed(
          (upcoming[days] ?? []).filter(
            (row) =>
              row.nextPaymentDate.getTime() <= row.currentPeriodEnd.getTime(),
          ),
        ),
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
    mintPayNow,
    recentProlongClaim: () => Effect.succeed(Option.none()),
  }) as unknown as SchedulerDeps;

const cfg = (days: readonly number[]) => ({
  intervalSeconds: 60,
  batchSize: 10,
  upcomingChargeNoticeDays: days,
  payNowClaimGraceSeconds: 3600,
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
      checkoutUrl: LINK.checkoutUrl,
      cycleOptions: [1, 3, 6],
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

const mintFailure = () =>
  new SqlError.SqlError({ cause: new Error('boom'), message: 'mint failed' });

it.effect('passes the minted link through, both fields', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub()] }, published), cfg([3]));

    const notice = published.find((e) => e.name === 'upcoming_charge');
    expect(notice?.payload.checkoutUrl).toBe(LINK.checkoutUrl);
    expect(notice?.payload.cycleOptions).toEqual([1, 3, 6]);
  }),
);

it.effect('no pay-now link: a null url and no cycle options', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    yield* scheduleTick(
      deps({ 3: [sub()] }, published, () => Effect.succeed(NO_PAY_NOW)),
      cfg([3]),
    );

    const notice = published.find((e) => e.name === 'upcoming_charge');
    expect(notice?.payload.checkoutUrl).toBeNull();
    expect(notice?.payload.cycleOptions).toEqual([]);
  }),
);

it.effect(
  'a failed mint skips that notice only, and the next tick sends it',
  () =>
    Effect.gen(function* () {
      const published: DomainEvent[] = [];
      let healthy = false;
      const mint: SchedulerDeps['mintPayNow'] = (s) =>
        s.id === 'sub-1' && !healthy
          ? Effect.fail(mintFailure())
          : Effect.succeed(LINK);
      const upcoming = { 3: [sub({ id: 'sub-1' }), sub({ id: 'sub-2' })] };

      yield* scheduleTick(deps(upcoming, published, mint), cfg([3]));
      expect(published.map((e) => e.aggregateId)).toEqual(['sub-2']);

      healthy = true;
      yield* scheduleTick(deps(upcoming, published, mint), cfg([3]));
      const second = published.filter((e) => e.aggregateId === 'sub-1');
      expect(second).toHaveLength(1);
      const notice = second[0];
      expect(
        notice?.name === 'upcoming_charge' ? notice.payload.checkoutUrl : null,
      ).toBe(LINK.checkoutUrl);
    }),
);

it.effect('the event id is the same with and without a link', () =>
  Effect.gen(function* () {
    const withLink: DomainEvent[] = [];
    const without: DomainEvent[] = [];
    yield* scheduleTick(deps({ 3: [sub()] }, withLink), cfg([3]));
    yield* scheduleTick(
      deps({ 3: [sub()] }, without, () => Effect.succeed(NO_PAY_NOW)),
      cfg([3]),
    );

    expect(withLink[0]?.id).toBe(without[0]?.id);
  }),
);

it.effect('the 3-day and 1-day notices mint for the same (id, due date)', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const keys: string[] = [];
    const minted = new Map<string, PayNowLink>();
    // Key-memoizing, as the real minter is: one session per (sub, due date).
    const mint: SchedulerDeps['mintPayNow'] = (s) =>
      Effect.sync(() => {
        const key = `${s.id}:${s.nextPaymentDate.getTime().toString()}`;
        keys.push(key);
        const existing = minted.get(key);
        if (existing !== undefined) return existing;
        const link: PayNowLink = {
          checkoutUrl: `https://bill.example/checkout/chk_${minted.size.toString()}`,
          cycleOptions: [1],
        };
        minted.set(key, link);
        return link;
      });
    const s = sub();
    yield* scheduleTick(deps({ 3: [s], 1: [s] }, published, mint), cfg([3, 1]));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const urls = published.map((e) =>
      e.name === 'upcoming_charge' ? e.payload.checkoutUrl : undefined,
    );
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[0]).not.toBeNull();
  }),
);

it.effect('a due date of Mar 9 is announced as Mar 9', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const moved = sub({
      nextPaymentDate: new Date('2026-03-09T09:00:00.000Z'),
    });
    yield* scheduleTick(deps({ 3: [moved] }, published), cfg([3]));

    const notice = published.find((e) => e.name === 'upcoming_charge');
    expect(notice?.payload.chargeDate).toBe('2026-03-09T09:00:00.000Z');
  }),
);

it.effect('a sub the near-due guard deferred gets no second notice', () =>
  Effect.gen(function* () {
    const published: DomainEvent[] = [];
    const minted: Payment[] = [];
    // Deferred: nextPaymentDate pushed a day past the unchanged anchor.
    const deferred = sub({
      id: 'sub-deferred',
      nextPaymentDate: new Date('2026-10-03T09:05:00.000Z'),
    });
    const onTime = sub({ id: 'sub-on-time' });
    const recordMint: SchedulerDeps['mintPayNow'] = (payment) =>
      Effect.sync(() => {
        minted.push(payment);
        return LINK;
      });
    yield* scheduleTick(
      deps({ 1: [deferred, onTime] }, published, recordMint),
      cfg([1]),
    );

    expect(published.map((e) => e.aggregateId)).toEqual(['sub-on-time']);
    expect(minted.map((payment) => payment.id)).toEqual(['sub-on-time']);
  }),
);
