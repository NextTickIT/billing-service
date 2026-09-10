import { it } from '@effect/vitest';
import { type Payment, PaymentStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type {
  ExtendPayment,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import {
  createOrExtend,
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
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }),
    extend: (id, input) =>
      Effect.sync(() => {
        extended = { id, input };
      }),
    findById: () => Effect.die('unused'),
    findDue: () => Effect.die('unused'),
    advanceAfterSuccess: () => Effect.die('unused'),
    recordRetry: () => Effect.die('unused'),
    markRenewalFailed: () => Effect.die('unused'),
    findByExternalUser: () => Effect.die('unused'),
    listAll: () => Effect.die('unused'),
    requestCancel: () => Effect.die('unused'),
    clearCancelRequest: () => Effect.die('unused'),
    markCancelledLapsed: () => Effect.die('unused'),
    defer: () => Effect.die('unused'),
    updateToken: () => Effect.die('unused'),
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
