import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type CheckoutSession,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Either, Option } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  claimPayableSession,
  resolvePayableSessionId,
  resolveProlongable,
} from '@/modules/checkout/routes.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';

/**
 * The `/pay` refusals (method lock AC 23, Q8 intro offers) and `/prolong`'s sub
 * resolution, at the unit level. Every refusal must happen before any write: these fakes
 * record releases, re-issues and claims so a test can assert nothing moved.
 */

const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const TTL_SECONDS = 86_400;

const die = () => Effect.die('unexpected repo call');

const session = (over: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_old',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  period: 'P4W',
  method: PaymentMethod.Card,
  status: CheckoutSessionStatus.Created,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: 'prolong',
  renewalOf: 'pay_live',
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(NOW + HOUR),
  createdAt: new Date(NOW - HOUR),
  ...over,
});

const sub = (over: Partial<Payment> = {}): Payment => ({
  id: 'pay_live',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  method: PaymentMethod.Card,
  period: 'P4W',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: new Date(NOW - 10 * 24 * HOUR),
  currentPeriodEnd: new Date(NOW + 18 * 24 * HOUR),
  nextPaymentDate: new Date(NOW + 18 * 24 * HOUR),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date(NOW - 40 * 24 * HOUR),
  updatedAt: new Date(NOW - 40 * 24 * HOUR),
  ...over,
});

interface Writes {
  released: string[];
  reissued: NewCheckoutSession[];
  claimed: { id: string; method: number }[];
}

/** A repo over a session table; `claimOk` lets a test make the SQL claim refuse. */
const repoWith = (
  rows: CheckoutSession[],
  claimOk: (id: string, method: number) => boolean = () => true,
): { repo: CheckoutRepo; writes: Writes } => {
  const writes: Writes = { released: [], reissued: [], claimed: [] };
  const byId = (id: string) =>
    Option.fromNullable(rows.find((row) => row.id === id));
  const repo = {
    findById: (id: string) => Effect.sync(() => byId(id)),
    reissueLapsed: (input: NewCheckoutSession) =>
      Effect.sync(() => {
        writes.reissued.push(input);
        return input.id;
      }),
    releasePending: (id: string) =>
      Effect.sync(() => {
        writes.released.push(id);
      }),
    claimForPayment: (id: string, method: number) =>
      Effect.sync(() => {
        const ok = claimOk(id, method);
        if (ok) writes.claimed.push({ id, method });
        return ok;
      }),
    findByIdempotencyKey: die,
    insert: die,
    completeIfOpen: die,
    renameOpenSessionsExternalUser: die,
  } as unknown as CheckoutRepo;
  return { repo, writes };
};

const live = (payment: Payment | null) => () =>
  Effect.succeed(Option.fromNullable(payment));

const resolve = (repo: CheckoutRepo, found: Payment | null, method: number) =>
  Effect.runSync(
    resolvePayableSessionId(
      { sessions: repo, findActiveRecurring: live(found) },
      'chk_old',
      method,
      NOW,
      TTL_SECONDS,
    ).pipe(Effect.either),
  );

const claim = (
  repo: CheckoutRepo,
  found: Payment | null,
  id: string,
  method: number,
) =>
  Effect.runSync(
    claimPayableSession(
      { sessions: repo, findActiveRecurring: live(found) },
      id,
      method,
      NOW,
    ).pipe(Effect.either),
  );

const leftTag = (result: Either.Either<unknown, { _tag: string }>) =>
  Either.isLeft(result) ? result.left._tag : null;

describe('T31: the prolong method lock at /pay', () => {
  test('a Card prolong link paid with Crypto → MethodLocked(Card), nothing written', () => {
    const { repo, writes } = repoWith([session()]);
    const result = resolve(repo, sub(), PaymentMethod.Crypto);

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Card,
    });
    expect(writes).toEqual({ released: [], reissued: [], claimed: [] });
  });

  test('a Pending prolong link paid with the wrong method is NOT released', () => {
    const { repo, writes } = repoWith([
      session({ status: CheckoutSessionStatus.Pending }),
    ]);
    const result = resolve(repo, sub(), PaymentMethod.Crypto);

    expect(leftTag(result)).toBe('MethodLocked');
    expect(writes.released).toEqual([]);
  });

  test('the locked method passes and a Pending link is released as before', () => {
    const { repo, writes } = repoWith([
      session({ status: CheckoutSessionStatus.Pending }),
    ]);
    const result = resolve(repo, sub(), PaymentMethod.Card);

    expect(result).toEqual(Either.right('chk_old'));
    expect(writes.released).toEqual(['chk_old']);
  });
});

describe("T31: a lapsed prolong link re-mints locked to the sub's current method", () => {
  test('an expired Card prolong whose sub is now Crypto: Card → MethodLocked(Crypto), no replacement', () => {
    const { repo, writes } = repoWith([
      session({ expiresAt: new Date(NOW - HOUR) }),
    ]);
    const result = resolve(
      repo,
      sub({ method: PaymentMethod.Crypto, recurringTokenRef: null }),
      PaymentMethod.Card,
    );

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Crypto,
    });
    expect(writes).toEqual({ released: [], reissued: [], claimed: [] });
  });

  test('…and the second press with Crypto mints a Crypto-locked replacement', () => {
    const { repo, writes } = repoWith([
      session({ expiresAt: new Date(NOW - HOUR) }),
    ]);
    const result = resolve(
      repo,
      sub({ method: PaymentMethod.Crypto, recurringTokenRef: null }),
      PaymentMethod.Crypto,
    );

    expect(Either.isRight(result)).toBe(true);
    expect(writes.reissued).toHaveLength(1);
    expect(writes.reissued[0]).toMatchObject({
      origin: 'prolong',
      method: PaymentMethod.Crypto,
      renewalOf: 'pay_live',
    });
  });

  test('the mirror: an expired Crypto prolong whose sub is now Card', () => {
    const { repo, writes } = repoWith([
      session({
        method: PaymentMethod.Crypto,
        expiresAt: new Date(NOW - HOUR),
      }),
    ]);
    const result = resolve(repo, sub(), PaymentMethod.Crypto);

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Card,
    });
    expect(writes.reissued).toEqual([]);
  });

  test('a manual_renewal link is not locked: a crypto prompt may be paid by card', () => {
    const { repo } = repoWith([
      session({ origin: 'manual_renewal', method: PaymentMethod.Crypto }),
    ]);
    const result = resolve(
      repo,
      sub({ method: PaymentMethod.Crypto, recurringTokenRef: null }),
      PaymentMethod.Card,
    );

    expect(result).toEqual(Either.right('chk_old'));
  });
});

describe('T31: the method lock at claim time', () => {
  test('claim re-checks the lock on the row it claims', () => {
    const { repo, writes } = repoWith([session()]);
    const result = claim(repo, sub(), 'chk_old', PaymentMethod.Crypto);

    expect(leftTag(result)).toBe('MethodLocked');
    expect(writes.claimed).toEqual([]);
  });

  test('claim backstop: the SQL predicate refuses after the method changed → MethodLocked, not Conflict', () => {
    const rows = [session()];
    // The row's method flips between the pre-check and the UPDATE (the SQL lock fires).
    const { repo } = repoWith(rows, () => {
      rows[0] = session({ method: PaymentMethod.Crypto });
      return false;
    });
    const result = claim(repo, sub(), 'chk_old', PaymentMethod.Card);

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Crypto,
    });
  });

  test('a lost claim race on an unlocked session is still the old 409', () => {
    const { repo } = repoWith([session({ origin: null })], () => false);
    const result = claim(repo, sub(), 'chk_old', PaymentMethod.Card);

    expect(leftTag(result)).toBe('Conflict');
  });
});

describe('T35: Q8 — an intro offer is refused while a live sub exists', () => {
  const intro = (over: Partial<CheckoutSession> = {}) =>
    session({
      origin: null,
      renewalOf: null,
      amount: 100,
      period: 'P1W',
      renewal: { amount: 5000, period: 'P4W' },
      ...over,
    });

  test.each([
    ['Active', PaymentStatus.Active],
    ['PastDue', PaymentStatus.PastDue],
  ])('%s sub → AlreadySubscribed, session untouched', (_label, status) => {
    const { repo, writes } = repoWith([
      intro({ status: CheckoutSessionStatus.Pending }),
    ]);
    const result = resolve(repo, sub({ status }), PaymentMethod.Card);

    expect(leftTag(result)).toBe('AlreadySubscribed');
    expect(writes).toEqual({ released: [], reissued: [], claimed: [] });
  });

  test('no live sub → payable', () => {
    const { repo } = repoWith([intro()]);
    expect(resolve(repo, null, PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
  });

  test('a renewal equal to the first charge, or none, is not an intro: it stacks', () => {
    const same = repoWith([
      intro({ amount: 5000, period: 'P4W', id: 'chk_old' }),
    ]);
    expect(resolve(same.repo, sub(), PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
    const none = repoWith([intro({ renewal: null })]);
    expect(resolve(none.repo, sub(), PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
  });

  test('a lapsed intro link with a PastDue sub → 409, no re-mint', () => {
    const { repo, writes } = repoWith([
      intro({ expiresAt: new Date(NOW - HOUR) }),
    ]);
    const result = resolve(
      repo,
      sub({ status: PaymentStatus.PastDue }),
      PaymentMethod.Card,
    );

    expect(leftTag(result)).toBe('AlreadySubscribed');
    expect(writes.reissued).toEqual([]);
  });

  test('claim re-checks Q8: a sub that went live after the preflight → 409', () => {
    const { repo, writes } = repoWith([intro()]);
    const result = claim(repo, sub(), 'chk_old', PaymentMethod.Card);

    expect(leftTag(result)).toBe('AlreadySubscribed');
    expect(writes.claimed).toEqual([]);
  });
});

describe('T6: resolveProlongable', () => {
  const run = (found: Payment | null) =>
    Effect.runSync(resolveProlongable(live(found), 'sp:1').pipe(Effect.either));

  test.each([
    ['Active', PaymentStatus.Active],
    ['PastDue', PaymentStatus.PastDue],
  ])('%s → the sub', (_label, status) => {
    const result = run(sub({ status }));
    expect(Either.isRight(result) && result.right.id).toBe('pay_live');
  });

  test.each([
    ['none', null],
    ['RenewalFailed', sub({ status: PaymentStatus.RenewalFailed })],
    ['Cancelled', sub({ status: PaymentStatus.Cancelled })],
    ['one-time', sub({ recurring: false })],
  ])('%s → 404 NotFound', (_label, found) => {
    expect(leftTag(run(found))).toBe('NotFound');
  });
});

describe('C2: a still-live renewal link that names another sub is re-minted', () => {
  test.each([['prolong'], ['manual_renewal']] as const)(
    'a %s link for sub A, paid while B is the live sub → re-minted at B',
    (origin) => {
      const { repo, writes } = repoWith([
        session({ origin, renewalOf: 'pay_A', amount: 900, period: 'P1W' }),
      ]);
      const result = resolve(repo, sub(), PaymentMethod.Card);

      expect(Either.isRight(result)).toBe(true);
      expect(writes.reissued).toHaveLength(1);
      expect(writes.reissued[0]).toMatchObject({
        origin,
        renewalOf: 'pay_live',
        amount: 5000,
        period: 'P4W',
        method: PaymentMethod.Card,
      });
    },
  );

  test('a link for the live sub itself is paid as-is', () => {
    const { repo, writes } = repoWith([session()]);
    expect(resolve(repo, sub(), PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
    expect(writes.reissued).toEqual([]);
  });

  test('a stale link already handed to the provider (Pending) is refused, not re-minted', () => {
    const { repo, writes } = repoWith([
      session({ renewalOf: 'pay_A', status: CheckoutSessionStatus.Pending }),
    ]);
    const result = resolve(repo, sub(), PaymentMethod.Card);

    expect(leftTag(result)).toBe('Conflict');
    expect(writes).toEqual({ released: [], reissued: [], claimed: [] });
  });
});

describe('C2: the prolong lock follows the live sub when its method changed', () => {
  const nowCrypto = () =>
    sub({ method: PaymentMethod.Crypto, recurringTokenRef: null });

  test('a still-live Card prolong, sub now Crypto: Card → MethodLocked(Crypto), nothing written', () => {
    const { repo, writes } = repoWith([session()]);
    const result = resolve(repo, nowCrypto(), PaymentMethod.Card);

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Crypto,
    });
    expect(writes).toEqual({ released: [], reissued: [], claimed: [] });
  });

  test('…and Crypto mints a Crypto-locked replacement for the same sub', () => {
    const { repo, writes } = repoWith([session()]);
    const result = resolve(repo, nowCrypto(), PaymentMethod.Crypto);

    expect(Either.isRight(result)).toBe(true);
    expect(writes.reissued[0]).toMatchObject({
      origin: 'prolong',
      method: PaymentMethod.Crypto,
      renewalOf: 'pay_live',
    });
  });

  test('a manual_renewal link is not method-locked, so a method change alone is not stale', () => {
    const { repo, writes } = repoWith([
      session({ origin: 'manual_renewal', method: PaymentMethod.Card }),
    ]);
    expect(resolve(repo, nowCrypto(), PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
    expect(writes.reissued).toEqual([]);
  });
});

describe('C3: intro pricing compares periods by value', () => {
  test("renewal 'P28D' over a 'P4W' first charge is not an intro: payable on a live sub", () => {
    const { repo } = repoWith([
      session({
        origin: null,
        renewalOf: null,
        renewal: { amount: 5000, period: 'P28D' },
      }),
    ]);
    expect(resolve(repo, sub(), PaymentMethod.Card)).toEqual(
      Either.right('chk_old'),
    );
  });
});
