import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type CheckoutSession,
  type NewCheckoutSession,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { describe, expect, test } from 'vitest';

import { resolvePayableSessionId } from '@/modules/checkout/routes.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';

const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const TTL_SECONDS = 86_400;

const die = () => Effect.die('unexpected repo call');

const session = (over: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_old',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  period: 'P1M',
  method: 0,
  status: CheckoutSessionStatus.Created,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: { additionalFreePeriod: 'P7D' },
  idempotencyKey: 'sp:1',
  expiresAt: new Date(NOW - HOUR), // lapsed an hour ago
  createdAt: new Date(NOW - 2 * HOUR),
  ...over,
});

/** Captures what, if anything, was minted. */
const repoWith = (
  found: CheckoutSession | null,
  issuedInWindow = 0,
): { repo: CheckoutRepo; minted: NewCheckoutSession[] } => {
  const minted: NewCheckoutSession[] = [];
  const repo = {
    findById: () => Effect.succeed(Option.fromNullable(found)),
    findByIdempotencyKey: die,
    countRecentByExternalUser: () => Effect.succeed(issuedInWindow),
    insert: (input: NewCheckoutSession) => {
      minted.push(input);
      return Effect.succeed(true);
    },
    claimForPayment: die,
    releasePending: die,
    markCompleted: die,
    renameOpenSessionsExternalUser: die,
  } as unknown as CheckoutRepo;
  return { repo, minted };
};

const noSubscription = () => Effect.succeed(Option.none<Payment>());
const subscription = (status: PaymentStatus) => () =>
  Effect.succeed(Option.some({ status } as Payment));

const run = (
  repo: CheckoutRepo,
  findActive: Parameters<typeof resolvePayableSessionId>[1],
) =>
  Effect.runSync(
    resolvePayableSessionId(repo, findActive, 'chk_old', NOW, TTL_SECONDS).pipe(
      Effect.either,
    ),
  );

describe('a lapsed link is re-issued instead of refused', () => {
  test('mints a fresh session on the same terms and charges that one', () => {
    const { repo, minted } = repoWith(session());
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Right');
    expect(minted).toHaveLength(1);
    const fresh = minted[0]!;
    // A NEW id — which is also the orderReference — so we never re-POST a reference
    // WayForPay has already seen.
    expect(fresh.id).not.toBe('chk_old');
    expect(fresh.id.startsWith('chk_')).toBe(true);
    expect(result._tag === 'Right' && result.right).toBe(fresh.id);
    // Terms ride across untouched.
    expect(fresh.amount).toBe(5000);
    expect(fresh.currency).toBe(1);
    expect(fresh.period).toBe('P1M');
    expect(fresh.externalUserId).toBe('sp:1');
    expect(fresh.recurring).toBe(true);
    // The promo was never spent — this checkout was never paid — so it carries over.
    expect(fresh.promo).toEqual({ additionalFreePeriod: 'P7D' });
    // The key is unique across live rows and this is a new checkout, not a replay.
    expect(fresh.idempotencyKey).toBeNull();
    expect(fresh.expiresAt.getTime()).toBe(NOW + TTL_SECONDS * 1000);
  });

  test('a still-live link is paid as-is, nothing minted', () => {
    const { repo, minted } = repoWith(
      session({ expiresAt: new Date(NOW + HOUR) }),
    );
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Right');
    expect(result._tag === 'Right' && result.right).toBe('chk_old');
    expect(minted).toHaveLength(0);
  });

  test('an unknown link is still a 404', () => {
    const { repo } = repoWith(null);
    const result = run(repo, noSubscription);
    expect(result._tag).toBe('Left');
  });
});

describe('guards on re-issue', () => {
  test('refuses when the buyer already has a live subscription', () => {
    const { repo, minted } = repoWith(session());
    const result = run(repo, subscription(PaymentStatus.Active));

    expect(result._tag).toBe('Left');
    expect(minted).toHaveLength(0);
  });

  test.each([
    ['PastDue', PaymentStatus.PastDue],
    ['RenewalFailed', PaymentStatus.RenewalFailed],
  ])('%s owes money, so they are allowed to pay', (_label, status) => {
    const { repo, minted } = repoWith(session());
    const result = run(repo, subscription(status));

    expect(result._tag).toBe('Right');
    expect(minted).toHaveLength(1);
  });

  test('a completed checkout is never re-issued', () => {
    const { repo, minted } = repoWith(
      session({ status: CheckoutSessionStatus.Completed }),
    );
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Left');
    expect(minted).toHaveLength(0);
  });

  test('a one-time purchase is not re-issued (no subscription to check against)', () => {
    const { repo, minted } = repoWith(session({ recurring: false }));
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Left');
    expect(minted).toHaveLength(0);
  });

  test('a card-change session is not re-issued — its own endpoint mints it', () => {
    const { repo, minted } = repoWith(
      session({ kind: CheckoutSessionKind.CardChange }),
    );
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Left');
    expect(minted).toHaveLength(0);
  });

  test('caps re-issues per user per day, since each mints a real provider order', () => {
    const { repo, minted } = repoWith(session(), 5);
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Left');
    expect(minted).toHaveLength(0);
  });

  test('still allowed one below the cap', () => {
    const { repo, minted } = repoWith(session(), 4);
    const result = run(repo, noSubscription);

    expect(result._tag).toBe('Right');
    expect(minted).toHaveLength(1);
  });
});
