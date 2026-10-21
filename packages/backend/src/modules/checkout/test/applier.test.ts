import { it } from '@effect/vitest';
import { type Payment, PaymentStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import { makeCheckoutApplier } from '@/modules/checkout/domain.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import type { Charge, Match } from '@/modules/charge/contracts.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod } from '@/modules/payment/period.js';

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
  transaction: (effect) => effect,
  lockById: () => Effect.die('unused'),
  findById: () => Effect.die('unused'),
  findDue: () => Effect.die('unused'),
  findUpcomingForNotice: () => Effect.succeed([]),
  insert: () => Effect.die('unused'),
  extend: () => Effect.die('unused'),
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
const unusedCheckout: CheckoutRepo = {
  findById: () => Effect.die('unused'),
  findByIdempotencyKey: () => Effect.die('unused'),
  reissueLapsed: () => Effect.die('unexpected reissueLapsed'),
  insert: () => Effect.die('unused'),
  claimForPayment: () => Effect.die('unused'),
  releasePending: () => Effect.die('unused'),
  completeIfOpen: () => Effect.die('unused'),
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
              metadata: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            };
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () =>
          Effect.sync(() => {
            completed = true;
            return true;
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

      expect(result).toEqual({
        subscriptionId: 'sub_1',
        created: true,
        prolonged: false,
        nextPaymentDate: addPeriod(event.occurredAt, 'P1M'),
        // The window this charge bought: paid-at through paid-at + period.
        periodStart: event.occurredAt,
        periodEnd: addPeriod(event.occurredAt, 'P1M'),
        metadata: null,
      });
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
              metadata: null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            };
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () => Effect.succeed(true),
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

      // The applier still surfaces the paid-through anchor; the one-time event builder is
      // what nulls it (a one-time never renews) — the applier result itself carries it.
      expect(result).toEqual({
        subscriptionId: 'pay_ot',
        created: true,
        prolonged: false,
        nextPaymentDate: addPeriod(event.occurredAt, 'P1M'),
        periodStart: event.occurredAt,
        periodEnd: addPeriod(event.occurredAt, 'P1M'),
        metadata: null,
      });
      expect(insertedRecurring).toBe(false);
      // The provider returned a recToken; a one-time payment must not store it.
      expect(insertedToken).toBe(null);
    }),
);

it.effect(
  'a recurring match reports the existing subscription and its next charge date, writing nothing',
  () => {
    // The recurring branch READS the payment (for its next-charge date) but writes nothing —
    // the scheduler already advanced it before the incoming event re-entered the pipeline.
    const recurringPayment: Payment = {
      id: 'sub_x',
      externalUserId: 'sp:1',
      amount: 30000,
      currency: 0,
      method: 0,
      period: 'P1M',
      status: PaymentStatus.Active,
      recurring: true,
      currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
      nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
      recurringTokenRef: 'tok',
      firstFailureAt: null,
      retryAttempt: 0,
      cancelRequestedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const subs: PaymentRepo = {
      ...unusedSubs,
      findById: () => Effect.succeed(Option.some(recurringPayment)),
    };
    return makeCheckoutApplier(subs, unusedCheckout)(event, {
      matched: true,
      kind: 'recurring',
      subscriptionId: 'sub_x',
      externalUserId: 'sp:1',
      period: 'P1M',
      method: 0,
    }).pipe(
      Effect.map((result) => {
        expect(result).toEqual({
          subscriptionId: 'sub_x',
          created: false,
          prolonged: false,
          nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          // Read off the payment the scheduler already advanced — a renewal reports the
          // window it is in and the intent the buyer last declared, not nothing.
          periodStart: new Date('2026-02-01T00:00:00Z'),
          periodEnd: new Date('2026-03-01T00:00:00Z'),
          metadata: null,
        });
      }),
    );
  },
);

it.effect(
  'a recurring match whose charge carries a settlement reports it, without reading the row',
  () =>
    // `unusedSubs` dies on any read: what the scheduler credited is the whole answer, and
    // the row — possibly moved on by a defer since — is never consulted.
    makeCheckoutApplier(unusedSubs, unusedCheckout)(
      {
        ...event,
        settlement: {
          periodStart: new Date('2026-02-01T00:00:00Z'),
          periodEnd: new Date('2026-03-01T00:00:00Z'),
          nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          metadata: { planCode: 'half_year' },
        },
      },
      {
        matched: true,
        kind: 'recurring',
        subscriptionId: 'sub_x',
        externalUserId: 'sp:1',
        period: 'P1M',
        method: 0,
      },
    ).pipe(
      Effect.map((result) => {
        expect(result).toEqual({
          subscriptionId: 'sub_x',
          created: false,
          prolonged: false,
          periodStart: new Date('2026-02-01T00:00:00Z'),
          periodEnd: new Date('2026-03-01T00:00:00Z'),
          nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
          metadata: { planCode: 'half_year' },
        });
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
  metadata: null,
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
  amountCharged: true,
  arrears: true,
  origin: 'card_change_arrears',
};

it.effect(
  'an owed card change advances the payment exactly once: a second charge loses the session claim',
  () =>
    Effect.gen(function* () {
      // The session claim (completeIfOpen) is what makes it once: the first charge
      // completes the session, any later charge on it finds it completed and writes
      // nothing. (A replay of the SAME charge never reaches the applier: the pipeline's
      // matchResult lock short-circuits it.)
      let open = true;
      let advanceCalls = 0;
      let tokenUpdated: string | null = null;
      const subs: PaymentRepo = {
        ...unusedSubs,
        updateToken: (_id, token) =>
          Effect.sync(() => {
            tokenUpdated = token;
          }),
        // A card change now also records the destination method (Card); a no-op here.
        setMethod: () => Effect.void,
        lockById: () => Effect.succeed(Option.some(owingPayment)),
        advanceAfterSuccess: () =>
          Effect.sync(() => {
            advanceCalls += 1;
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () =>
          Effect.sync(() => {
            const won = open;
            open = false;
            return won;
          }),
      };
      const owedEvent: Charge = { ...event, payload: { recToken: 'newtok' } };
      const applier = makeCheckoutApplier(subs, checkout);

      const first = yield* applier(owedEvent, owedCardChange);
      const second = yield* applier(
        { ...owedEvent, idemKey: 'k2', payload: { recToken: 'othertok' } },
        owedCardChange,
      );

      expect(advanceCalls).toBe(1);
      expect(tokenUpdated).toBe('newtok');
      // PastDue end Jan 1, credited from that anchor: +P1M.
      expect(first).toEqual({
        subscriptionId: 'pay_1',
        created: false,
        prolonged: false,
        nextPaymentDate: new Date('2026-02-01T00:00:00Z'),
        // Past its end on the charge date: the credited window starts at the old end.
        periodStart: new Date('2026-01-01T00:00:00Z'),
        periodEnd: new Date('2026-02-01T00:00:00Z'),
        metadata: null,
      });
      expect(second).toEqual({
        refused: 'already_applied',
        subscriptionId: 'pay_1',
      });
    }),
);

// ---- Session claim, paid-after-death, card-change crediting (T10, T11) ----

const checkoutMatch = (over: Partial<Match> = {}): Match => ({
  matched: true,
  kind: 'checkout',
  subscriptionId: null,
  externalUserId: 'sp:1',
  period: 'P1M',
  method: 0,
  recurring: true,
  amount: 30000,
  currency: 0,
  ...over,
});

it.effect(
  'a different charge on a completed session is alreadyApplied and writes nothing',
  () =>
    Effect.gen(function* () {
      // unusedSubs dies on any payment read or write.
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () => Effect.succeed(false),
      };

      const result = yield* makeCheckoutApplier(unusedSubs, checkout)(
        event,
        checkoutMatch(),
      );

      expect(result).toEqual({
        refused: 'already_applied',
        subscriptionId: null,
      });
    }),
);

it.effect.each([
  ['prolong', PaymentStatus.RenewalFailed],
  ['prolong', PaymentStatus.Cancelled],
  ['manual_renewal', PaymentStatus.RenewalFailed],
  ['manual_renewal', PaymentStatus.Cancelled],
] as const)(
  'a %s session paid after its sub became %s inserts a fresh auto-charging row at paidAt',
  ([origin, status]) =>
    Effect.gen(function* () {
      const dead: Payment = {
        ...owingPayment,
        id: 'sub_dead',
        status,
        cancelRequestedAt: new Date('2026-01-01T00:00:00Z'),
      };
      let inserted: Record<string, unknown> | null = null;
      const subs: PaymentRepo = {
        ...unusedSubs,
        // The finder already excludes dead rows; the lock is what sees the death in a
        // race, so both paths are covered by returning the dead row from the lock.
        findActiveRecurringByExternalUser: () =>
          Effect.succeed(Option.some(dead)),
        lockById: () => Effect.succeed(Option.some(dead)),
        insert: (input) =>
          Effect.sync(() => {
            inserted = { ...input };
            return {
              ...input,
              id: 'sub_fresh',
              cancelRequestedAt: null,
              metadata: input.metadata ?? null,
              createdAt: new Date(0),
              updatedAt: new Date(0),
            };
          }),
      };
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () => Effect.succeed(true),
      };

      const result = yield* makeCheckoutApplier(subs, checkout)(
        event,
        checkoutMatch({ origin, renewalOf: 'sub_dead' }),
      );

      expect(result).toMatchObject({
        subscriptionId: 'sub_fresh',
        created: true,
        prolonged: false,
      });
      // The callback's token, auto-charging; the dead row is never written (extend dies).
      expect(inserted).toMatchObject({
        recurring: true,
        recurringTokenRef: 'tok',
        currentPeriodStart: event.occurredAt,
      });
    }),
);

/** A card-change repo whose locked row has `status`, recording advances. */
const cardChangeRepo = (status: PaymentStatus) => {
  const advances: { start: Date; end: Date }[] = [];
  const subs: PaymentRepo = {
    ...unusedSubs,
    updateToken: () => Effect.void,
    setMethod: () => Effect.void,
    clearToken: () => Effect.void,
    lockById: () => Effect.succeed(Option.some({ ...owingPayment, status })),
    findById: () => Effect.succeed(Option.some({ ...owingPayment, status })),
    advanceAfterSuccess: (_id, anchor) =>
      Effect.sync(() => {
        advances.push({
          start: anchor.currentPeriodStart,
          end: anchor.currentPeriodEnd,
        });
      }),
  };
  const checkout: CheckoutRepo = {
    ...unusedCheckout,
    completeIfOpen: () => Effect.succeed(true),
  };
  return { applier: makeCheckoutApplier(subs, checkout), advances };
};

it.effect(
  'an arrears session credits its OWN period, whatever the row adopted since',
  () =>
    Effect.gen(function* () {
      // The row now renews P1M (owingPayment.period); the arrears session was minted P4W.
      const { applier, advances } = cardChangeRepo(PaymentStatus.Active);

      const result = yield* applier(event, {
        ...owedCardChange,
        period: 'P4W',
      });

      // Stacked on the locked end (Jan 1) + 4 weeks.
      expect(advances).toEqual([
        {
          start: new Date('2026-01-01T00:00:00Z'),
          end: new Date('2026-01-29T00:00:00Z'),
        },
      ]);
      expect(result).toMatchObject({
        nextPaymentDate: new Date('2026-01-29T00:00:00Z'),
      });
    }),
);

it.effect('an arrears session on a cancelled row credits nothing', () =>
  Effect.gen(function* () {
    const { applier, advances } = cardChangeRepo(PaymentStatus.Cancelled);

    yield* applier(event, owedCardChange);

    expect(advances).toEqual([]);
  }),
);

it.effect(
  'a token charge minted while Active never advances, even settled while PastDue',
  () =>
    Effect.gen(function* () {
      const { applier, advances } = cardChangeRepo(PaymentStatus.PastDue);

      const result = yield* applier(event, {
        ...owedCardChange,
        arrears: false,
        origin: 'card_change',
      });

      expect(advances).toEqual([]);
      // Money moved, so the unchanged schedule is reported.
      expect(result).toMatchObject({
        nextPaymentDate: owingPayment.nextPaymentDate,
      });
    }),
);

it.effect(
  'a legacy (origin null) priced session keeps the old rule: advance only while owing',
  () =>
    Effect.gen(function* () {
      const legacy: Match = { ...owedCardChange, origin: null };

      const active = cardChangeRepo(PaymentStatus.Active);
      yield* active.applier(event, legacy);
      expect(active.advances).toEqual([]);

      const pastDue = cardChangeRepo(PaymentStatus.PastDue);
      yield* pastDue.applier(event, legacy);
      expect(pastDue.advances).toHaveLength(1);
    }),
);

/** A fake `transaction` that records each savepoint and whether it failed (the real one
 * rolls back on failure; the fake only observes it). */
const observedSavepoint = () => {
  const counts = { opened: 0, rolledBack: 0 };
  const markRolledBack = Effect.sync(() => {
    counts.rolledBack += 1;
  });
  const transaction: PaymentRepo['transaction'] = (effect) => {
    counts.opened += 1;
    return effect.pipe(Effect.tapError(() => markRolledBack));
  };
  return { counts, transaction };
};

it.effect(
  'an intro-priced checkout on a live sub is refused and its session claim rolled back',
  () =>
    Effect.gen(function* () {
      const live: Payment = { ...owingPayment, status: PaymentStatus.Active };
      const savepoint = observedSavepoint();
      const subs: PaymentRepo = {
        ...unusedSubs,
        transaction: savepoint.transaction,
        findActiveRecurringByExternalUser: () =>
          Effect.succeed(Option.some(live)),
        lockById: () => Effect.succeed(Option.some(live)),
      };
      let claimed = 0;
      const checkout: CheckoutRepo = {
        ...unusedCheckout,
        completeIfOpen: () =>
          Effect.sync(() => {
            claimed += 1;
            return true;
          }),
      };

      const result = yield* makeCheckoutApplier(subs, checkout)(
        event,
        checkoutMatch({
          amount: 1000,
          renewal: { amount: 30000, period: 'P1M' },
        }),
      );

      expect(result).toEqual({
        refused: 'intro_on_live',
        subscriptionId: 'pay_1',
      });
      // The claim ran inside the savepoint that was then rolled back.
      expect(claimed).toBe(1);
      expect(savepoint.counts).toEqual({ opened: 1, rolledBack: 1 });
    }),
);
