import { it } from '@effect/vitest';
import { type Subscription, SubscriptionStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type {
  ExtendSubscription,
  SubscriptionRepo,
} from '@/modules/subscription/data-access.js';
import {
  createOrExtend,
  type ApplyPaymentParams,
} from '@/modules/subscription/domain.js';

const params: ApplyPaymentParams = {
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  recurringTokenRef: 'tok_1',
  paidAt: new Date('2026-01-15T00:00:00Z'),
};

const activeSubscription: Subscription = {
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: SubscriptionStatus.Active,
  nextChargeDate: new Date('2026-01-15T00:00:00Z'),
  recurringTokenRef: 'tok_old',
  firstFailureAt: null,
  retryAttempt: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const makeFakeRepo = (existing: Subscription | null) => {
  let inserted: unknown = null;
  let extended: { id: string; input: ExtendSubscription } | null = null;
  const repo: SubscriptionRepo = {
    findActiveByExternalUser: () =>
      Effect.succeed(existing === null ? Option.none() : Option.some(existing)),
    insert: (input) =>
      Effect.sync(() => {
        inserted = input;
        return {
          ...input,
          id: 'sub_new',
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
    cancel: () => Effect.die('unused'),
  };
  return { repo, getInserted: () => inserted, getExtended: () => extended };
};

it.effect('creates a subscription when the user has none active', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo(null);

    const result = yield* createOrExtend(fake.repo)(params);

    expect(result.created).toBe(true);
    expect(result.subscriptionId).toBe('sub_new');
    // next charge = paid date + period.
    const inserted = fake.getInserted() as { nextChargeDate: Date };
    expect(inserted.nextChargeDate.toISOString().slice(0, 10)).toBe(
      '2026-02-15',
    );
  }),
);

it.effect('extends the existing active subscription in place', () =>
  Effect.gen(function* () {
    const fake = makeFakeRepo(activeSubscription);

    const result = yield* createOrExtend(fake.repo)(params);

    expect(result.created).toBe(false);
    expect(result.subscriptionId).toBe('sub_1');
    const extended = fake.getExtended();
    expect(extended?.id).toBe('sub_1');
    expect(extended?.input.recurringTokenRef).toBe('tok_1');
    expect(extended?.input.nextChargeDate.toISOString().slice(0, 10)).toBe(
      '2026-02-15',
    );
  }),
);
