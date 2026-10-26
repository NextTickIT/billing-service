import { it } from '@effect/vitest';
import { type Payment, PaymentStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type {
  ExtendPayment,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import {
  advanceLocked,
  createOrExtend,
  isIntroPriced,
  type ApplyPaymentParams,
} from '@/modules/payment/domain.js';

const params: ApplyPaymentParams = {
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  recurring: true,
  recurringTokenRef: 'tok_1',
  paidAt: new Date('2026-01-15T00:00:00Z'),
};

const activePayment: Payment = {
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: new Date('2025-12-15T00:00:00Z'),
  currentPeriodEnd: new Date('2026-01-15T00:00:00Z'),
  nextPaymentDate: new Date('2026-01-15T00:00:00Z'),
  recurringTokenRef: 'tok_old',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const makeFakeRepo = (existing: Payment | null) => {
  let inserted: unknown = null;
  let extended: { id: string; input: ExtendPayment } | null = null;
  const repo: PaymentRepo = {
    findActiveRecurringByExternalUser: () =>
      Effect.succeed(existing === null ? Option.none() : Option.some(existing)),
    insert: (input) =>
      Effect.sync(() => {
        inserted = input;
        return {
          ...input,
          id: 'sub_new',
          cancelRequestedAt: null,
          // The real repo returns what it stored; a fake that always answered
          // `null` here hid the `metadata ?? null` → `metadata && null` mutant.
          metadata: input.metadata ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }),
    extend: (id, input) =>
      Effect.sync(() => {
        extended = { id, input };
      }),
    transaction: (effect) => effect,
    lockById: () =>
      Effect.succeed(existing === null ? Option.none() : Option.some(existing)),
    findById: () => Effect.die('unused'),
    findDue: () => Effect.die('unused'),
    findUpcomingForNotice: () => Effect.succeed([]),
    advanceAfterSuccess: () => Effect.die('unused'),
    recordRetry: () => Effect.die('unused'),
    markRenewalFailed: () => Effect.die('unused'),
    findByExternalUser: () => Effect.die('unused'),
    findByContactName: () => Effect.die('unused'),
    listAll: () => Effect.die('unused'),
    requestCancel: () => Effect.die('unused'),
    clearCancelRequest: () => Effect.die('unused'),
    markCancelledLapsed: () => Effect.die('unused'),
    cancelUpstream: () => Effect.die('unused'),
    defer: () => Effect.die('unused'),
    updateToken: () => Effect.die('unused'),
    setMethod: () => Effect.die('unused'),
    clearToken: () => Effect.die('unused'),
    setEmail: () => Effect.succeed(0),
    renameExternalUser: () => Effect.die('unused'),
  };
  return { repo, getInserted: () => inserted, getExtended: () => extended };
};

it.effect('creates a payment when the user has none active', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo(null);

    const result = yield* createOrExtend(fake.repo)(params);

    expect(result.created).toBe(true);
    expect(result.subscriptionId).toBe('sub_new');
    const inserted = fake.getInserted() as {
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      nextPaymentDate: Date;
    };
    // currentPeriodStart = paidAt
    expect(inserted.currentPeriodStart.toISOString().slice(0, 10)).toBe(
      '2026-01-15',
    );
    // currentPeriodEnd = nextPaymentDate = paidAt + period
    expect(inserted.currentPeriodEnd.toISOString().slice(0, 10)).toBe(
      '2026-02-15',
    );
    expect(inserted.nextPaymentDate.toISOString().slice(0, 10)).toBe(
      '2026-02-15',
    );
  }),
);

it.effect('extends the existing active payment in place', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo(activePayment);

    const result = yield* createOrExtend(fake.repo)(params);

    expect(result.created).toBe(false);
    expect(result.subscriptionId).toBe('sub_1');
    const extended = fake.getExtended();
    expect(extended?.id).toBe('sub_1');
    expect(extended?.input.recurringTokenRef).toBe('tok_1');
    expect(extended?.input.nextPaymentDate.toISOString().slice(0, 10)).toBe(
      '2026-02-15',
    );
  }),
);

it.effect(
  'a promo bonus pushes the anchor once, on top of the paid period',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);

      // paidAt + P1M = 2026-02-15, then +P14D bonus = 2026-03-01. Both the paid-through
      // anchor and the derived next charge date move together by the bonus.
      const result = yield* createOrExtend(fake.repo)({
        ...params,
        promoBonus: 'P14D',
      });

      expect(result.created).toBe(true);
      const inserted = fake.getInserted() as {
        currentPeriodEnd: Date;
        nextPaymentDate: Date;
      };
      expect(inserted.currentPeriodEnd.toISOString().slice(0, 10)).toBe(
        '2026-03-01',
      );
      expect(inserted.nextPaymentDate.toISOString().slice(0, 10)).toBe(
        '2026-03-01',
      );
    }),
);

it.effect(
  'an absent promo bonus leaves the anchor at the paid period end',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);

      // A null bonus is the common case: no extra free time, anchor = paidAt + period.
      yield* createOrExtend(fake.repo)({ ...params, promoBonus: null });

      const inserted = fake.getInserted() as { currentPeriodEnd: Date };
      expect(inserted.currentPeriodEnd.toISOString().slice(0, 10)).toBe(
        '2026-02-15',
      );
    }),
);

// The two tests below exist because Stryker reported their mutants as survived:
// `promoBonus.length > 0` → `true` / `>= 0`, and `metadata ?? null` → `metadata && null`.
// 100% line coverage, zero tests exercising the empty-string and the present-metadata
// inputs — the gap coverage cannot see.
it.effect(
  'an empty promo bonus string grants no free time (and is not passed to addPeriod)',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);

      yield* createOrExtend(fake.repo)({ ...params, promoBonus: '' });

      const inserted = fake.getInserted() as { currentPeriodEnd: Date };
      expect(inserted.currentPeriodEnd.toISOString().slice(0, 10)).toBe(
        '2026-02-15',
      );
    }),
);

it.effect(
  'metadata supplied with the charge is stored on the new payment',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);
      const metadata = { source: 'promo-landing', campaign: 'spring' };

      const result = yield* createOrExtend(fake.repo)({ ...params, metadata });

      const inserted = fake.getInserted() as { metadata: unknown };
      expect(inserted.metadata).toEqual(metadata);
      expect(result.metadata).toEqual(metadata);
    }),
);

it.effect(
  'revives a PastDue recurring payment in place (crypto manual-renewal pay), not a duplicate',
  () =>
    Effect.gen(function* () {
      // A crypto manual-renewal prompt flips the payment to PastDue (recordRetry). When the
      // user then pays the manual session, create-or-extend must EXTEND that same (PastDue)
      // payment — reviving it — not insert a second recurring payment. The finder returning
      // the PastDue row is what makes this work (see findActiveRecurringByExternalUser SQL).
      const pastDue: Payment = {
        ...activePayment,
        status: PaymentStatus.PastDue,
        firstFailureAt: new Date('2026-01-01T00:00:00Z'),
        retryAttempt: 2,
        recurringTokenRef: null,
      };
      const fake = makeFakeRepo(pastDue);

      const result = yield* createOrExtend(fake.repo)(params);

      expect(result.created).toBe(false);
      expect(result.subscriptionId).toBe('sub_1');
      expect(fake.getInserted()).toBe(null); // never a duplicate
      expect(fake.getExtended()?.id).toBe('sub_1');
    }),
);

it.effect(
  'a one-time charge inserts a fresh payment even when an active one exists',
  () =>
    Effect.gen(function* () {
      // An active recurring payment is present, yet a one-time charge must not extend
      // it: it inserts a brand-new record with recurring=false and no stored token.
      const fake = makeFakeRepo(activePayment);

      const result = yield* createOrExtend(fake.repo)({
        ...params,
        recurring: false,
      });

      expect(result.created).toBe(true);
      expect(result.subscriptionId).toBe('sub_new');
      expect(fake.getExtended()).toBe(null);
      const inserted = fake.getInserted() as {
        recurring: boolean;
        recurringTokenRef: string | null;
      };
      expect(inserted.recurring).toBe(false);
      expect(inserted.recurringTokenRef).toBe(null);
    }),
);

// ---- Renewal terms and stacking (checkout renewal + prolong, T3–T5, T27, T32) ----

it.effect(
  'a first payment stores the renewal terms, anchored on the first charge and promo',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);

      // P8W first charge + P1W promo, renewing at 5000 every P4W.
      yield* createOrExtend(fake.repo)({
        ...params,
        amount: 9000,
        period: 'P8W',
        promoBonus: 'P1W',
        renewal: { amount: 5000, period: 'P4W' },
      });

      const inserted = fake.getInserted() as {
        amount: number;
        period: string;
        currentPeriodEnd: Date;
      };
      expect(inserted.amount).toBe(5000);
      expect(inserted.period).toBe('P4W');
      // paidAt Jan 15 + 8 weeks = Mar 12, + 1 week promo = Mar 19.
      expect(inserted.currentPeriodEnd).toEqual(
        new Date('2026-03-19T00:00:00Z'),
      );
    }),
);

/** An Active row paid through Feb 1, prolonged on Jan 15 (end ≠ paidAt). */
const paidAhead: Payment = {
  ...activePayment,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
};

it.effect(
  'a recurring charge on a live row stacks on its end and adopts the session terms',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(paidAhead);

      // Not an intro offer (renewal = first charge, M1), so the row adopts 5000 / P4W.
      const result = yield* createOrExtend(fake.repo)({
        ...params,
        amount: 5000,
        period: 'P4W',
        currency: 1,
        renewal: { amount: 5000, period: 'P4W' },
      });

      expect(result).toEqual({
        subscriptionId: 'sub_1',
        created: false,
        prolonged: true,
        reactivated: false,
        nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
        // The window this charge bought is the stacked one written below.
        periodStart: new Date('2026-01-01T00:00:00Z'),
        periodEnd: new Date('2026-03-01T00:00:00Z'),
        // Nothing declared on this charge: the row's own (none) stands.
        metadata: null,
      });
      expect(fake.getInserted()).toBe(null);
      expect(fake.getExtended()).toEqual({
        id: 'sub_1',
        input: {
          amount: 5000,
          currency: 1,
          period: 'P4W',
          method: 0,
          recurringTokenRef: 'tok_1',
          // Still inside its period: the start is kept, the end moves Feb 1 + 4 weeks → Mar 1.
          currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
          currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
          nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
        },
      });
    }),
);

it.effect(
  'a promo on a prolonging checkout is ignored: no free time stacks',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(paidAhead);

      yield* createOrExtend(fake.repo)({ ...params, promoBonus: 'P14D' });

      expect(fake.getExtended()?.input.currentPeriodEnd).toEqual(
        new Date('2026-03-01T00:00:00Z'),
      );
    }),
);

it.effect(
  'a PastDue row stacks from its old end and keeps no stale token',
  () =>
    Effect.gen(function* () {
      const pastDue: Payment = {
        ...activePayment,
        status: PaymentStatus.PastDue,
        firstFailureAt: new Date('2026-01-15T00:00:00Z'),
        retryAttempt: 2,
        currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
      };
      const fake = makeFakeRepo(pastDue);

      const result = yield* createOrExtend(fake.repo)(params);

      expect(result.prolonged).toBe(true);
      // `extend` itself sets Active and resets dunning; the anchors start at the old end.
      expect(fake.getExtended()?.input).toMatchObject({
        currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-02-01T00:00:00Z'),
      });
    }),
);

it.effect('a WhitePay prolongation drops the token and records Crypto', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo(paidAhead);

    yield* createOrExtend(fake.repo)({
      ...params,
      recurringTokenRef: null,
      source: 'whitepay_callback',
    });

    expect(fake.getExtended()?.input).toMatchObject({
      recurringTokenRef: null,
      method: 1,
    });
  }),
);

it.effect(
  'a card prolongation stores the newer token, or keeps the stored one without it',
  () =>
    Effect.gen(function* () {
      const withNew = makeFakeRepo(paidAhead);
      yield* createOrExtend(withNew.repo)({
        ...params,
        recurringTokenRef: 'tok_new',
        source: 'wayforpay_callback',
      });
      expect(withNew.getExtended()?.input.recurringTokenRef).toBe('tok_new');

      const without = makeFakeRepo(paidAhead);
      yield* createOrExtend(without.repo)({
        ...params,
        recurringTokenRef: null,
        source: 'wayforpay_callback',
      });
      expect(without.getExtended()?.input).toMatchObject({
        recurringTokenRef: 'tok_old',
        method: 0,
      });
    }),
);

it.effect('prolonging a cancel-pending row reports the reactivation', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo({
      ...paidAhead,
      cancelRequestedAt: new Date('2026-01-10T00:00:00Z'),
    });

    const result = yield* createOrExtend(fake.repo)(params);

    expect(result.reactivated).toBe(true);
  }),
);

it.effect(
  'a live row that died before the lock gets a fresh row anchored at paidAt',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(paidAhead);
      const repo: PaymentRepo = {
        ...fake.repo,
        lockById: () =>
          Effect.succeed(
            Option.some({ ...paidAhead, status: PaymentStatus.RenewalFailed }),
          ),
      };

      const result = yield* createOrExtend(repo)(params);

      expect(result).toMatchObject({ created: true, prolonged: false });
      expect(fake.getExtended()).toBe(null);
      const inserted = fake.getInserted() as { currentPeriodStart: Date };
      expect(inserted.currentPeriodStart).toEqual(params.paidAt);
    }),
);

it.effect(
  'advanceLocked credits the period from the locked anchor, or skips on the guard',
  () =>
    Effect.gen(function* () {
      const advanced: unknown[] = [];
      const repo: PaymentRepo = {
        ...makeFakeRepo(paidAhead).repo,
        advanceAfterSuccess: (id, anchor) =>
          Effect.sync(() => {
            advanced.push({ id, anchor });
          }),
      };

      const next = yield* advanceLocked(repo)(
        'sub_1',
        'P1M',
        new Date('2026-02-03T00:00:00Z'),
        () => true,
      );
      const refused = yield* advanceLocked(repo)(
        'sub_1',
        'P1M',
        new Date('2026-02-03T00:00:00Z'),
        () => false,
      );

      expect(next).toEqual(
        Option.some({
          currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
          currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
          nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          metadata: null,
        }),
      );
      expect(refused).toEqual(Option.none());
      expect(advanced).toEqual([
        {
          id: 'sub_1',
          anchor: {
            currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
            currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
            nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          },
        },
      ]);
    }),
);

// ---- Q8 at settlement: an intro offer never stacks onto a live payment (M1) ----

it('isIntroPriced compares periods by the time they add, not by spelling', () => {
  const base = { amount: 5000, period: 'P4W' };
  expect(isIntroPriced({ ...base, renewal: null })).toBe(false);
  expect(
    isIntroPriced({ ...base, renewal: { amount: 5000, period: 'P28D' } }),
  ).toBe(false);
  expect(
    isIntroPriced({ ...base, renewal: { amount: 9000, period: 'P4W' } }),
  ).toBe(true);
  expect(
    isIntroPriced({ ...base, renewal: { amount: 5000, period: 'P1M' } }),
  ).toBe(true);
});

it.effect(
  'an intro-priced charge on a live row writes nothing and reports introOnLive',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(paidAhead);

      // 1000 for the first P1M, then 30000 every P1M: an intro offer.
      const result = yield* createOrExtend(fake.repo)({
        ...params,
        amount: 1000,
        renewal: { amount: 30000, period: 'P1M' },
      });

      expect(result).toEqual({
        subscriptionId: 'sub_1',
        created: false,
        prolonged: false,
        introOnLive: true,
        nextPaymentDate: paidAhead.nextPaymentDate,
        // Nothing was written, so the row's own window and declaration are reported.
        periodStart: paidAhead.currentPeriodStart,
        periodEnd: paidAhead.currentPeriodEnd,
        metadata: null,
      });
      expect(fake.getExtended()).toBe(null);
      expect(fake.getInserted()).toBe(null);
    }),
);

it.effect(
  'an intro-priced charge with no live row creates the sub as usual',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(null);

      const result = yield* createOrExtend(fake.repo)({
        ...params,
        amount: 1000,
        renewal: { amount: 30000, period: 'P1M' },
      });

      expect(result).toMatchObject({ created: true, prolonged: false });
      expect(result.introOnLive).toBeUndefined();
    }),
);

it.effect(
  'renewal terms equal to the first charge in another spelling still stack',
  () =>
    Effect.gen(function* () {
      const fake = makeFakeRepo(paidAhead);

      const result = yield* createOrExtend(fake.repo)({
        ...params,
        period: 'P4W',
        renewal: { amount: params.amount, period: 'P28D' },
      });

      expect(result.prolonged).toBe(true);
    }),
);
