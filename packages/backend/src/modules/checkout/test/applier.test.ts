import { it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import { makeCheckoutApplier } from '@/modules/checkout/domain.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { Charge, Match } from '@/modules/charge/contracts.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

const event: Charge = {
  source: 'wayforpay_callback',
  idemKey: 'k',
  externalRef: 'chk_1',
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date('2026-01-15T00:00:00Z'),
  payload: { recToken: 'tok' },
};

/** A repo whose every method fails the test if called (the recurring path). */
const unusedSubs: PaymentRepo = {
  findActiveByExternalUser: () => Effect.die('unused'),
  findById: () => Effect.die('unused'),
  findDue: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  extend: () => Effect.die('unused'),
  advanceAfterSuccess: () => Effect.die('unused'),
  recordRetry: () => Effect.die('unused'),
  markRenewalFailed: () => Effect.die('unused'),
  findByExternalUser: () => Effect.die('unused'),
  listAll: () => Effect.die('unused'),
  cancel: () => Effect.die('unused'),
};
const unusedCheckout: CheckoutRepo = {
  findById: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  setPending: () => Effect.die('unused'),
  markCompleted: () => Effect.die('unused'),
};

it.effect(
  'a checkout match creates a subscription, stores the token, completes',
  () =>
    Effect.gen(function* () {
      let insertedToken: string | null = 'unset';
      let completed = false;
      const subs: PaymentRepo = {
        ...unusedSubs,
        findActiveByExternalUser: () => Effect.succeed(Option.none()),
        insert: (input) =>
          Effect.sync(() => {
            insertedToken = input.recurringTokenRef;
            return {
              ...input,
              id: 'sub_1',
              cancelRequestedAt: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            };
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        markCompleted: () =>
          Effect.sync(() => {
            completed = true;
          }),
      };
      const match: Match = {
        matched: true,
        kind: 'checkout',
        subscriptionId: null,
        externalUserId: 'sp:1',
        period: 'P1M',
        method: 0,
      };

      const result = yield* makeCheckoutApplier(subs, checkout)(event, match);

      expect(result).toEqual({ subscriptionId: 'sub_1', created: true });
      expect(insertedToken).toBe('tok');
      expect(completed).toBe(true);
    }),
);

it.effect(
  'a recurring match reports the existing subscription, touching nothing',
  () =>
    makeCheckoutApplier(unusedSubs, unusedCheckout)(event, {
      matched: true,
      kind: 'recurring',
      subscriptionId: 'sub_x',
      externalUserId: 'sp:1',
      period: 'P1M',
      method: 0,
    }).pipe(
      Effect.map((result) => {
        expect(result).toEqual({ subscriptionId: 'sub_x', created: false });
      }),
    ),
);
