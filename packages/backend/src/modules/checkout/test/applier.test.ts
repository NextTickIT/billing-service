import { it } from '@effect/vitest';
import { type Payment, PaymentStatus } from '@billing-service/shared';
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
  findActiveRecurringByExternalUser: () => Effect.die('unused'),
  findById: () => Effect.die('unused'),
  findDue: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  extend: () => Effect.die('unused'),
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
const unusedCheckout: CheckoutRepo = {
  findById: () => Effect.die('unused'),
  insert: () => Effect.die('unused'),
  setPending: () => Effect.die('unused'),
  markCompleted: () => Effect.die('unused'),
  renameOpenSessionsExternalUser: () => Effect.die('unused'),
};

it.effect(
  'a checkout match creates a subscription, stores the token, completes',
  () =>
    Effect.gen(function* () {
      let insertedToken: string | null = 'unset';
      let completed = false;
      const subs: PaymentRepo = {
        ...unusedSubs,
        findActiveRecurringByExternalUser: () => Effect.succeed(Option.none()),
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
  'a one-time checkout inserts a fresh payment, never extending, storing no token',
  () =>
    Effect.gen(function* () {
      let insertedRecurring: boolean | null = null;
      let insertedToken: string | null = 'unset';
      // findActiveRecurringByExternalUser stays `Effect.die('unused')` (via unusedSubs):
      // a one-time payment must be inserted outright, never looked up to extend.
      const subs: PaymentRepo = {
        ...unusedSubs,
        insert: (input) =>
          Effect.sync(() => {
            insertedRecurring = input.recurring;
            insertedToken = input.recurringTokenRef;
            return {
              ...input,
              id: 'pay_ot',
              cancelRequestedAt: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            };
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        markCompleted: () => Effect.void,
      };
      const match: Match = {
        matched: true,
        kind: 'checkout',
        subscriptionId: null,
        externalUserId: 'sp:1',
        period: 'P1M',
        method: 0,
        recurring: false,
      };

      const result = yield* makeCheckoutApplier(subs, checkout)(event, match);

      expect(result).toEqual({ subscriptionId: 'pay_ot', created: true });
      expect(insertedRecurring).toBe(false);
      // The provider returned a recToken; a one-time payment must not store it.
      expect(insertedToken).toBe(null);
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

/** A past_due payment the owed card-change advances (only the read status matters). */
const owingPayment: Payment = {
  id: 'pay_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.PastDue,
  recurring: true,
  currentPeriodStart: new Date('2025-12-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-01-01T00:00:00Z'),
  nextPaymentDate: new Date('2026-01-01T00:00:00Z'),
  recurringTokenRef: 'old',
  firstFailureAt: new Date('2026-01-01T00:00:00Z'),
  retryAttempt: 2,
  cancelRequestedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const owedCardChange: Match = {
  matched: true,
  kind: 'card_change',
  subscriptionId: 'pay_1',
  externalUserId: 'sp:1',
  period: 'P1M',
  method: 0,
  owed: true,
};

it.effect(
  'an owed card change advances the payment exactly once across a redelivery',
  () =>
    Effect.gen(function* () {
      // The advance flips status past_due → active; simulate that so the second run
      // reads an `active` payment and the `owesMoney` guard skips the second advance.
      let status = PaymentStatus.PastDue;
      let advanceCalls = 0;
      let tokenUpdated: string | null = null;
      const subs: PaymentRepo = {
        ...unusedSubs,
        updateToken: (_id, token) =>
          Effect.sync(() => {
            tokenUpdated = token;
          }),
        findById: () =>
          Effect.succeed(Option.some({ ...owingPayment, status })),
        advanceAfterSuccess: () =>
          Effect.sync(() => {
            advanceCalls += 1;
            status = PaymentStatus.Active;
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        markCompleted: () => Effect.void,
      };
      const owedEvent: Charge = { ...event, payload: { recToken: 'newtok' } };
      const applier = makeCheckoutApplier(subs, checkout);

      yield* applier(owedEvent, owedCardChange);
      yield* applier(owedEvent, owedCardChange); // reaper redelivery

      expect(advanceCalls).toBe(1);
      expect(tokenUpdated).toBe('newtok');
    }),
);
