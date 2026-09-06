import { SqlError } from '@effect/sql';
import { it } from '@effect/vitest';
import type { NewExternalUserIdChange, Payment } from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { ExternalUserIdChangeRepo } from '@/modules/identity/data-access.js';
import { renameExternalUser } from '@/modules/identity/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

const die = () => Effect.die('unused');

const unusedPayments: PaymentRepo = {
  findActiveRecurringByExternalUser: die,
  findById: die,
  findDue: die,
  insert: die,
  extend: die,
  advanceAfterSuccess: die,
  recordRetry: die,
  markRenewalFailed: die,
  findByExternalUser: die,
  listAll: die,
  requestCancel: die,
  clearCancelRequest: die,
  markCancelledLapsed: die,
  defer: die,
  updateToken: die,
  renameExternalUser: die,
};

const unusedCheckout: CheckoutRepo = {
  findById: die,
  insert: die,
  setPending: die,
  markCompleted: die,
  renameOpenSessionsExternalUser: die,
};

/** A recurring payment already owned by the target id (blocks a rename onto it). */
const existingPayment: Payment = {
  id: 'pay_existing',
  externalUserId: 'sp:new',
  amount: 1000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: 0,
  recurring: true,
  currentPeriodStart: new Date(0),
  currentPeriodEnd: new Date(0),
  nextPaymentDate: new Date(0),
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** A payments repo whose remap moves `moved` rows, or fails with the one-active-per-user
 * unique violation (SQLSTATE 23505) when `moved` is 'conflict'. `existingAtTarget` is
 * what `findByExternalUser(to)` returns — non-empty means the target id is occupied. */
const payments = (
  moved: number | 'conflict',
  existingAtTarget: readonly Payment[] = [],
): PaymentRepo => ({
  ...unusedPayments,
  findByExternalUser: () => Effect.succeed(existingAtTarget),
  renameExternalUser: () =>
    moved === 'conflict'
      ? Effect.fail(new SqlError.SqlError({ cause: { code: '23505' } }))
      : Effect.succeed(moved),
});

const checkout = (moved: number): CheckoutRepo => ({
  ...unusedCheckout,
  renameOpenSessionsExternalUser: () => Effect.succeed(moved),
});

const ledger = (): {
  repo: ExternalUserIdChangeRepo;
  appends: NewExternalUserIdChange[];
} => {
  const appends: NewExternalUserIdChange[] = [];
  return {
    appends,
    repo: {
      append: (input) =>
        Effect.sync(() => {
          appends.push(input);
          return { ...input, id: 'euc_1', occurredAt: new Date(0) };
        }),
    },
  };
};

const cmd = { from: 'sp:old', to: 'sp:new' };

it.effect('remaps live records and appends the change to the ledger', () =>
  Effect.gen(function* () {
    const log = ledger();
    const deps = {
      payments: payments(2),
      checkout: checkout(1),
      ledger: log.repo,
    };

    const result = yield* renameExternalUser(deps)(cmd, 'service');

    expect(result).toEqual({
      from: 'sp:old',
      to: 'sp:new',
      movedPayments: 2,
      movedSessions: 1,
    });
    expect(log.appends).toHaveLength(1);
    expect(log.appends[0]).toMatchObject({
      fromExternalUserId: 'sp:old',
      toExternalUserId: 'sp:new',
      source: 'service',
      reason: null,
      movedPayments: 2,
      movedSessions: 1,
    });
  }),
);

it.effect(
  'rejects a no-op rename (from === to) without touching any repo',
  () =>
    Effect.gen(function* () {
      const log = ledger();
      const deps = {
        payments: unusedPayments,
        checkout: unusedCheckout,
        ledger: log.repo,
      };

      const error = yield* Effect.flip(
        renameExternalUser(deps)({ from: 'sp:x', to: 'sp:x' }, 'service'),
      );

      expect(error._tag).toBe('UnprocessableEntity');
      expect(log.appends).toHaveLength(0);
    }),
);

it.effect('is a NotFound (no ledger row) when no live record matches', () =>
  Effect.gen(function* () {
    const log = ledger();
    const deps = {
      payments: payments(0),
      checkout: checkout(0),
      ledger: log.repo,
    };

    const error = yield* Effect.flip(renameExternalUser(deps)(cmd, 'service'));

    expect(error._tag).toBe('NotFound');
    expect(log.appends).toHaveLength(0);
  }),
);

it.effect('maps the one-active-per-user unique violation to a Conflict', () =>
  Effect.gen(function* () {
    const log = ledger();
    const deps = {
      payments: payments('conflict'),
      checkout: checkout(0),
      ledger: log.repo,
    };

    const error = yield* Effect.flip(renameExternalUser(deps)(cmd, 'service'));

    expect(error._tag).toBe('Conflict');
    expect(log.appends).toHaveLength(0);
  }),
);

it.effect('refuses a rename onto an id that already has billing records', () =>
  Effect.gen(function* () {
    const log = ledger();
    // The target id is occupied; the remap must not stack a second payment there.
    const deps = {
      payments: payments(2, [existingPayment]),
      checkout: checkout(1),
      ledger: log.repo,
    };

    const error = yield* Effect.flip(renameExternalUser(deps)(cmd, 'service'));

    expect(error._tag).toBe('Conflict');
    expect(log.appends).toHaveLength(0);
  }),
);
