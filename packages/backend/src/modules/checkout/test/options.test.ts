import { it } from '@effect/vitest';
import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { describe, expect } from 'vitest';

import type { Charge, Match } from '@/modules/charge/contracts.js';
import { recurringPaymentSucceeded } from '@/modules/charge/domain.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  choiceAt,
  chosenTerms,
  cycleOptions,
  defaultOptionIndex,
  makeCheckoutApplier,
  makeCheckoutMatcher,
  offeredCycles,
  publicOptions,
} from '@/modules/checkout/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod } from '@/modules/payment/period.js';

const ID = 'chk_0b5e6a3c-1f2d-4c7b-9a8e-1234567890ab';
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const base: CheckoutSession = {
  id: ID,
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 0,
  period: 'P4W',
  method: 0,
  status: CheckoutSessionStatus.Pending,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: null,
  renewalOf: null,
  options: null,
  metadata: null,
  idempotencyKey: null,
  email: '',
  expiresAt: d('2030-01-01'),
  createdAt: d('2026-01-01'),
};

/** A caller session whose flat terms (the default) are the second of three options. */
const withOptions: CheckoutSession = {
  ...base,
  options: [
    { amount: 2000, period: 'P1W' },
    { amount: 5000, period: 'P4W' },
    {
      amount: 13000,
      period: 'P12W',
      promo: { additionalFreePeriod: 'P7D' },
      renewal: { amount: 5000, period: 'P4W' },
    },
  ],
};

/** A manual-renewal session selling 1, 3 or 6 cycles of its base terms. */
const manual: CheckoutSession = {
  ...base,
  origin: 'manual_renewal',
  renewalOf: 'sub_1',
  options: [{ cycles: 1 }, { cycles: 3 }, { cycles: 6 }],
};

describe('option resolution', () => {
  it('a session without options offers the flat terms alone, as the default', () => {
    expect(defaultOptionIndex(base)).toBe(0);
    expect(publicOptions(base)).toEqual([
      { amount: 5000, period: 'P4W', promo: null, renewal: null, cycles: null },
    ]);
    expect(choiceAt(base, 0)).toEqual(Option.some({ kind: 'default' }));
    expect(choiceAt(base, 1)).toEqual(Option.none());
  });

  it('the flat terms are the default wherever they sit; the others are by index', () => {
    expect(defaultOptionIndex(withOptions)).toBe(1);
    expect(choiceAt(withOptions, 1)).toEqual(Option.some({ kind: 'default' }));
    expect(choiceAt(withOptions, 2)).toEqual(
      Option.some({ kind: 'option', index: 2 }),
    );
    expect(choiceAt(withOptions, 3)).toEqual(Option.none());
  });

  it('a cycle option shows its total and the time it buys', () => {
    expect(defaultOptionIndex(manual)).toBe(0);
    expect(
      publicOptions(manual).map((o) => [o.amount, o.period, o.cycles]),
    ).toEqual([
      [5000, 'P4W', 1],
      [15000, 'P12W', 3],
      [30000, 'P24W', 6],
    ]);
    expect(choiceAt(manual, 1)).toEqual(
      Option.some({ kind: 'cycles', cycles: 3 }),
    );
  });
});

/** A pay-now link: a prolong session selling 1, 3 or 6 cycles of the sub's terms. */
const prolong: CheckoutSession = {
  ...base,
  origin: 'prolong',
  renewalOf: 'sub_1',
  options: cycleOptions([1, 3, 6]),
};

describe('a prolong session with cycles', () => {
  it('shows each cycle count with its total and the time it buys', () => {
    expect(defaultOptionIndex(prolong)).toBe(0);
    expect(
      publicOptions(prolong).map((o) => [o.amount, o.period, o.cycles]),
    ).toEqual([
      [5000, 'P4W', 1],
      [15000, 'P12W', 3],
      [30000, 'P24W', 6],
    ]);
  });

  it('a pick resolves to its cycle choice and an out-of-range pick to none', () => {
    expect(choiceAt(prolong, 2)).toEqual(
      Option.some({ kind: 'cycles', cycles: 6 }),
    );
    expect(choiceAt(prolong, 3)).toEqual(Option.none());
    expect(
      Option.map(chosenTerms(prolong, { kind: 'cycles', cycles: 3 }), (c) => [
        c.total,
        c.cycles,
      ]),
    ).toEqual(Option.some([15000, 3]));
  });

  it('with the knob at 1 the session offers its flat terms alone', () => {
    const single = { ...prolong, options: cycleOptions([1]) };
    expect(publicOptions(single)).toHaveLength(1);
    expect(offeredCycles(single)).toEqual([1]);
  });
});

describe('cycle choices', () => {
  it('a cycle choice charges n × base but keeps the base terms for the subscription', () => {
    expect(chosenTerms(manual, { kind: 'cycles', cycles: 3 })).toEqual(
      Option.some({
        terms: { amount: 5000, period: 'P4W', promo: null, renewal: null },
        cycles: 3,
        total: 15000,
      }),
    );
    expect(chosenTerms(manual, { kind: 'cycles', cycles: 4 })).toEqual(
      Option.none(),
    );
    expect(chosenTerms(base, { kind: 'cycles', cycles: 3 })).toEqual(
      Option.none(),
    );
  });

  it('only a session selling cycles reports cycles on its default', () => {
    expect(
      Option.map(chosenTerms(manual, { kind: 'default' }), (c) => c.cycles),
    ).toEqual(Option.some(1));
    expect(
      Option.map(chosenTerms(base, { kind: 'default' }), (c) => c.cycles),
    ).toEqual(Option.some(null));
  });

  it('the env cycle list is stored as options only when it offers a choice', () => {
    expect(cycleOptions([1])).toBeNull();
    expect(cycleOptions([1, 3, 6])).toEqual([
      { cycles: 1 },
      { cycles: 3 },
      { cycles: 6 },
    ]);
    expect(offeredCycles(manual)).toEqual([1, 3, 6]);
    expect(offeredCycles(base)).toEqual([1]);
  });
});

const repoWith = (found: CheckoutSession): CheckoutRepo => ({
  findById: (id) =>
    Effect.succeed(id === found.id ? Option.some(found) : Option.none()),
  findByIdempotencyKey: () => Effect.succeed(Option.none()),
  reissueLapsed: () => Effect.die('unexpected reissueLapsed'),
  insert: () => Effect.succeed(true),
  claimForPayment: () => Effect.succeed(false),
  releasePending: () => Effect.void,
  completeIfOpen: () => Effect.die('unused'),
  renameOpenSessionsExternalUser: () => Effect.succeed(0),
});

const noLiveSub = () => Effect.succeed(Option.none<Payment>());

const charge = (externalRef: string, amount: number): Charge => ({
  source: 'whitepay_callback',
  idemKey: `k:${externalRef}`,
  externalRef,
  externalUserId: null,
  amount,
  currency: 0,
  status: 'succeeded',
  occurredAt: d('2026-01-15'),
  payload: {},
});

const matchOf = (session: CheckoutSession, event: Charge) =>
  makeCheckoutMatcher(repoWith(session), noLiveSub)(event);

describe('checkout matcher', () => {
  it.effect('a non-default option matches with that option’s own terms', () =>
    Effect.map(matchOf(withOptions, charge(`${ID}_o2`, 13000)), (result) => {
      expect(result).toMatchObject({
        matched: true,
        amount: 13000,
        period: 'P12W',
        promoBonus: 'P7D',
        renewal: { amount: 5000, period: 'P4W' },
        cycles: null,
      });
    }),
  );

  it.effect('the bare session id still matches the flat terms', () =>
    Effect.map(matchOf(withOptions, charge(ID, 5000)), (result) => {
      expect(result).toMatchObject({
        matched: true,
        amount: 5000,
        period: 'P4W',
        promoBonus: null,
        renewal: null,
      });
    }),
  );

  it.effect('a _c3 ref matches at the base terms, three cycles', () =>
    Effect.map(matchOf(manual, charge(`${ID}_c3`, 15000)), (result) => {
      expect(result).toMatchObject({
        matched: true,
        amount: 5000,
        period: 'P4W',
        cycles: 3,
      });
    }),
  );

  it.effect.each([
    ['an option the session does not have', withOptions, `${ID}_o3`],
    ['a cycle option on a caller session', withOptions, `${ID}_c3`],
    ['a cycle count the session does not sell', manual, `${ID}_c4`],
    ['a caller option on a cycle session', manual, `${ID}_o1`],
    ['a suffix we never mint', manual, `${ID}_x3`],
  ] as const)('does not match %s', ([, session, ref]) =>
    Effect.map(matchOf(session, charge(ref, 15000)), (result) => {
      expect(result.matched).toBe(false);
    }),
  );
});

const live: Payment = {
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 0,
  method: 1,
  period: 'P4W',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: d('2026-01-01'),
  currentPeriodEnd: d('2026-01-29'),
  nextPaymentDate: d('2026-01-29'),
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

type Extended = Parameters<PaymentRepo['extend']>[1];
type Inserted = Parameters<PaymentRepo['insert']>[0];

interface Writes {
  extended: Extended | null;
  inserted: Inserted | null;
  completed: string | null;
}

const unused = () => Effect.die('unused');

/** A payment repo over at most one live row that records what settlement writes. */
const settlementRepos = (row: Payment | null, writes: Writes) => {
  const payments: PaymentRepo = {
    findActiveRecurringByExternalUser: () =>
      Effect.succeed(Option.fromNullable(row)),
    lockById: () => Effect.succeed(Option.fromNullable(row)),
    transaction: (effect) => effect,
    extend: (_id, input) =>
      Effect.sync(() => {
        writes.extended = input;
      }),
    insert: (input) =>
      Effect.sync(() => {
        writes.inserted = input;
        return {
          ...input,
          id: 'sub_new',
          cancelRequestedAt: null,
          metadata: input.metadata ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }),
    findById: unused,
    findDue: unused,
    findUpcomingForNotice: () => Effect.succeed([]),
    advanceAfterSuccess: unused,
    recordRetry: unused,
    markRenewalFailed: unused,
    findByExternalUser: unused,
    findByContactName: unused,
    listAll: unused,
    requestCancel: unused,
    clearCancelRequest: unused,
    markCancelledLapsed: unused,
    cancelUpstream: unused,
    defer: unused,
    updateToken: unused,
    setMethod: unused,
    clearToken: unused,
    setEmail: () => Effect.succeed(0),
    renameExternalUser: unused,
  };
  const checkout: CheckoutRepo = {
    ...repoWith(manual),
    completeIfOpen: (id) =>
      Effect.sync(() => {
        writes.completed = id;
        return true;
      }),
  };
  return { payments, checkout };
};

/** Match then apply one charge, as the pipeline does. */
const settle = (session: CheckoutSession, row: Payment | null, event: Charge) =>
  Effect.gen(function* () {
    const writes: Writes = { extended: null, inserted: null, completed: null };
    const { payments, checkout } = settlementRepos(row, writes);
    const match = yield* makeCheckoutMatcher(
      { ...checkout, findById: repoWith(session).findById },
      noLiveSub,
    )(event);
    expect(match.matched).toBe(true);
    const applied = yield* makeCheckoutApplier(payments, checkout)(
      event,
      match as Match,
    );
    return { applied, writes, match: match as Match };
  });

const threeCycles = (from: Date) =>
  addPeriod(addPeriod(addPeriod(from, 'P4W'), 'P4W'), 'P4W');

describe('settlement of a multi-cycle payment', () => {
  it.effect.each([
    ['live (Active)', PaymentStatus.Active],
    ['PastDue', PaymentStatus.PastDue],
  ] as const)(
    'a _c3 payment on a %s sub stacks three periods and keeps the base terms',
    ([, status]) =>
      Effect.gen(function* () {
        const row = { ...live, status };
        const { writes } = yield* settle(
          manual,
          row,
          charge(`${ID}_c3`, 15000),
        );
        expect(writes.completed).toBe(ID);
        expect(writes.extended).toMatchObject({
          amount: 5000,
          period: 'P4W',
          currentPeriodEnd: threeCycles(row.currentPeriodEnd),
          nextPaymentDate: threeCycles(row.currentPeriodEnd),
        });
      }),
  );

  it.effect(
    'a _c3 payment with no live sub creates one at the base terms, three periods long',
    () =>
      Effect.gen(function* () {
        const event = charge(`${ID}_c3`, 15000);
        const { writes } = yield* settle(manual, null, event);
        expect(writes.inserted).toMatchObject({
          amount: 5000,
          period: 'P4W',
          currentPeriodStart: event.occurredAt,
          currentPeriodEnd: threeCycles(event.occurredAt),
        });
      }),
  );
});

describe('settlement clamping and caller options', () => {
  it.effect(
    'three monthly cycles from Jan 31 end where the event says access ends',
    () =>
      Effect.gen(function* () {
        const monthly = { ...manual, period: 'P1M' };
        const row = {
          ...live,
          period: 'P1M',
          currentPeriodEnd: d('2026-01-31'),
        };
        const event = charge(`${ID}_c3`, 15000);
        const { writes, match } = yield* settle(monthly, row, event);
        // The sink grants access to the anchor plus the event's period, so settlement
        // must land on that same date: Jan 31 + P3M = Apr 30.
        const { period } = recurringPaymentSucceeded(event, match, 'sub_1', {
          nextPaymentDate: null,
          periodStart: null,
          periodEnd: null,
          metadata: null,
        }).payload;
        expect(period).toBe('P3M');
        expect(writes.extended?.currentPeriodEnd).toEqual(
          addPeriod(row.currentPeriodEnd, period),
        );
        expect(writes.extended?.currentPeriodEnd).toEqual(d('2026-04-30'));
      }),
  );

  it.effect(
    'a non-default caller option settles with that option’s terms',
    () =>
      Effect.gen(function* () {
        const event = charge(`${ID}_o2`, 13000);
        const { writes } = yield* settle(withOptions, null, event);
        expect(writes.completed).toBe(ID);
        // The renewal terms are what the subscription stores; the first charge buys the
        // option's period plus its promo.
        expect(writes.inserted).toMatchObject({
          amount: 5000,
          period: 'P4W',
          currentPeriodEnd: addPeriod(
            addPeriod(event.occurredAt, 'P12W'),
            'P7D',
          ),
        });
      }),
  );
});
