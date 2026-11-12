import { SqlError } from '@effect/sql';
import { it } from '@effect/vitest';
import {
  type ExternalUserIdChange,
  type NewExternalUserIdChange,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { ExternalUserIdChangeRepo } from '@/modules/identity/data-access.js';
import { renameExternalUser } from '@/modules/identity/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';

const die = () => Effect.die('unused');

const unusedPayments: PaymentRepo = {
  findActiveRecurringByExternalUser: die,
  transaction: (effect) => effect,
  lockById: die,
  findById: die,
  findDue: die,
  findUpcomingForNotice: die,
  insert: die,
  extend: die,
  advanceAfterSuccess: die,
  recordRetry: die,
  markRenewalFailed: die,
  findByExternalUser: die,
  findByContactName: die,
  listAll: die,
  requestCancel: die,
  clearCancelRequest: die,
  markCancelledLapsed: die,
  cancelUpstream: die,
  defer: die,
  deferCharge: die,
  updateToken: die,
  setMethod: die,
  clearToken: die,
  setEmail: () => Effect.succeed(0),
  renameExternalUser: die,
};

const unusedCheckout: CheckoutRepo = {
  findById: die,
  everSentToProvider: die,
  findByIdempotencyKey: die,
  reissueLapsed: die,
  insert: die,
  claimForPayment: die,
  releasePending: die,
  completeIfOpen: die,
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
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const cmd = { from: 'sp:old', to: 'sp:new' };

/**
 * A payments repo whose remap moves `moved` rows (or fails with the one-active-per-user
 * 23505 violation when `moved` is 'conflict'). `findByExternalUser` answers per id:
 * `targetRecords` for `to` (non-empty → occupied), `fromRecords` for `from` (empty →
 * eligible for the idempotent-replay path). `from` defaults to a single existing payment
 * (a normal, non-replay rename).
 */
const payments = (
  moved: number | 'conflict',
  opts: {
    fromRecords?: readonly Payment[];
    targetRecords?: readonly Payment[];
  } = {},
): PaymentRepo => ({
  ...unusedPayments,
  findByExternalUser: (uid) =>
    Effect.succeed(
      uid === cmd.to
        ? (opts.targetRecords ?? [])
        : (opts.fromRecords ?? [existingPayment]),
    ),
  renameExternalUser: () =>
    moved === 'conflict'
      ? Effect.fail(new SqlError.SqlError({ cause: { code: '23505' } }))
      : Effect.succeed(moved),
});

const checkout = (moved: number): CheckoutRepo => ({
  ...unusedCheckout,
  renameOpenSessionsExternalUser: () => Effect.succeed(moved),
});

const ledger = (
  prior?: ExternalUserIdChange,
): {
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
      findLatestChange: () =>
        Effect.succeed(
          prior === undefined ? Option.none() : Option.some(prior),
        ),
      lockUsers: () => Effect.void,
    },
  };
};

/** A previously recorded sp:old → sp:new remap (the basis for an idempotent replay). */
const priorChange: ExternalUserIdChange = {
  id: 'euc_prior',
  fromExternalUserId: 'sp:old',
  toExternalUserId: 'sp:new',
  source: 'service',
  reason: null,
  movedPayments: 3,
  movedSessions: 1,
  occurredAt: new Date(0),
};

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
      // The id of the ledger row this rename just appended — what the emitted event keys
      // on, so a later A→B→A→B chain reports four changes instead of collapsing to one.
      changeId: 'euc_1',
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
    // from is empty and there is no prior remap on record → genuinely nothing to move.
    const deps = {
      payments: payments(0, { fromRecords: [] }),
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

it.effect.each([
  ['active', PaymentStatus.Active],
  ['past-due', PaymentStatus.PastDue],
  ['renewal-failed', PaymentStatus.RenewalFailed],
] as const)(
  'refuses a rename onto an id that holds a %s payment',
  ([, status]) =>
    Effect.gen(function* () {
      const log = ledger();
      // The target id holds a live payment; the remap must not stack a second one there.
      const deps = {
        payments: payments(2, {
          targetRecords: [{ ...existingPayment, status }],
        }),
        checkout: checkout(1),
        ledger: log.repo,
      };

      const error = yield* Effect.flip(
        renameExternalUser(deps)(cmd, 'service'),
      );

      expect(error._tag).toBe('Conflict');
      expect(log.appends).toHaveLength(0);
    }),
);

it.effect(
  'refuses a rename onto an id that holds a cancelled and a live payment',
  () =>
    Effect.gen(function* () {
      const log = ledger();
      const deps = {
        payments: payments(2, {
          targetRecords: [
            { ...existingPayment, status: PaymentStatus.Cancelled },
            {
              ...existingPayment,
              id: 'pay_live',
              status: PaymentStatus.Active,
            },
          ],
        }),
        checkout: checkout(1),
        ledger: log.repo,
      };

      const error = yield* Effect.flip(
        renameExternalUser(deps)(cmd, 'service'),
      );

      expect(error._tag).toBe('Conflict');
      expect(log.appends).toHaveLength(0);
    }),
);

it.effect(
  'remaps onto an id whose only payment is cancelled (a buyer who re-bought under another id)',
  () =>
    Effect.gen(function* () {
      const log = ledger();
      const deps = {
        payments: payments(1, {
          targetRecords: [
            { ...existingPayment, status: PaymentStatus.Cancelled },
          ],
        }),
        checkout: checkout(0),
        ledger: log.repo,
      };

      const result = yield* renameExternalUser(deps)(cmd, 'service');

      expect(result).toMatchObject({ movedPayments: 1, movedSessions: 0 });
      expect(log.appends).toHaveLength(1);
    }),
);

it.effect(
  'replays a prior identical rename (idempotent) without moving again',
  () =>
    Effect.gen(function* () {
      const log = ledger(priorChange);
      // from is already emptied and the remap is on record; renameExternalUser is stubbed
      // to fail, so a passing result proves the replay short-circuits before any move.
      const deps = {
        payments: payments('conflict', { fromRecords: [] }),
        checkout: checkout(0),
        ledger: log.repo,
      };

      const result = yield* renameExternalUser(deps)(cmd, 'service');

      expect(result).toEqual({
        from: 'sp:old',
        to: 'sp:new',
        movedPayments: 3,
        movedSessions: 1,
        // The RECORDED row, not a new one: a retried call must re-emit the same event key
        // so the outbox collapses it. This is what keeps the fix idempotent.
        changeId: 'euc_prior',
      });
      expect(log.appends).toHaveLength(0);
    }),
);

it.effect('locks both ids before deciding whether the target is free', () =>
  Effect.gen(function* () {
    const steps: string[] = [];
    const log = ledger();
    const deps = {
      payments: {
        ...payments(1),
        findByExternalUser: (uid: string) =>
          Effect.sync(() => {
            steps.push(`read ${uid}`);
            return uid === cmd.to ? [] : [existingPayment];
          }),
      },
      checkout: checkout(0),
      ledger: {
        ...log.repo,
        lockUsers: (ids: readonly string[]) =>
          Effect.sync(() => {
            steps.push(`lock ${[...ids].sort().join(',')}`);
          }),
      },
    };

    yield* renameExternalUser(deps)(cmd, 'service');

    expect(steps[0]).toBe('lock sp:new,sp:old');
    expect(steps).toContain('read sp:new');
  }),
);
