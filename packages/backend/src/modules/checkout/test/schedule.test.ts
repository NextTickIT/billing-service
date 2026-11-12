import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type CheckoutSession,
  CreateCheckoutSession,
  type NewCheckoutSession,
  type Payment,
  PaymentMethod,
} from '@billing-service/shared';
import { Effect, Either, Option, Schema } from 'effect';
import { describe, expect, test } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import { brokenScheduleRule } from '@/modules/checkout/domain.js';
import {
  claimPayableSession,
  effectivePayable,
  insertOrReplay,
  resolvePayableSessionId,
} from '@/modules/checkout/routes.js';

/**
 * `startsAt`, bounded offers (`payableUntil`) and `lockMethod`: the create-time bounds,
 * the `/pay` refusals, and the idempotent replay. Fakes record every write so a refusal
 * can be shown to have written nothing.
 */

const NOW = 1_790_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TTL_SECONDS = 86_400;
const expectedHorizon = 62 * DAY;

const die = () => Effect.die('unexpected repo call');

const session = (over: Partial<CheckoutSession> = {}): CheckoutSession => ({
  id: 'chk_old',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 1,
  period: 'P1M',
  method: PaymentMethod.Card,
  status: CheckoutSessionStatus.Created,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  renewal: null,
  origin: 'migration',
  renewalOf: null,
  startsAt: null,
  payableUntil: null,
  lockMethod: false,
  options: null,
  idempotencyKey: 'idem-1',
  email: '',
  metadata: null,
  expiresAt: new Date(NOW + HOUR),
  createdAt: new Date(NOW - HOUR),
  ...over,
});

/** A bounded offer as `createSession` stores it: it expires when it closes. */
const bounded = (closesAt: Date, over: Partial<CheckoutSession> = {}) =>
  session({ payableUntil: closesAt, expiresAt: closesAt, ...over });

const schedule = (over: {
  readonly recurring?: boolean;
  readonly startsAt?: Date;
  readonly payableUntil?: Date;
}) => ({ recurring: true, ...over });

describe('startsAt bounds at create', () => {
  test.each([
    ['now', new Date(NOW)],
    ['a day ahead', new Date(NOW + DAY)],
    ['exactly on the horizon', new Date(NOW + expectedHorizon)],
  ])('accepts a startsAt %s', (_label, startsAt) => {
    expect(brokenScheduleRule(schedule({ startsAt }), NOW)).toBeUndefined();
  });

  test('refuses a startsAt just in the past', () => {
    expect(
      brokenScheduleRule(schedule({ startsAt: new Date(NOW - 1) }), NOW),
    ).toBe('startsAt must not be in the past');
  });

  test('refuses a startsAt just past the horizon', () => {
    expect(
      brokenScheduleRule(
        schedule({ startsAt: new Date(NOW + expectedHorizon + 1) }),
        NOW,
      ),
    ).toBe('startsAt must be at most 62 days ahead');
  });

  test('refuses a startsAt on a one-time checkout', () => {
    expect(
      brokenScheduleRule(
        schedule({ recurring: false, startsAt: new Date(NOW + DAY) }),
        NOW,
      ),
    ).toBe('startsAt is only allowed on a recurring checkout');
  });

  test('a request without startsAt or payableUntil keeps every rule', () => {
    expect(brokenScheduleRule(schedule({}), NOW)).toBeUndefined();
    expect(
      brokenScheduleRule(schedule({ recurring: false }), NOW),
    ).toBeUndefined();
  });
});

describe('payableUntil bounds at create', () => {
  test.each([
    ['a millisecond ahead', new Date(NOW + 1)],
    ['exactly on the horizon', new Date(NOW + expectedHorizon)],
  ])('accepts a payableUntil %s', (_label, payableUntil) => {
    expect(brokenScheduleRule(schedule({ payableUntil }), NOW)).toBeUndefined();
  });

  test('refuses a payableUntil of now: the offer would be closed already', () => {
    expect(
      brokenScheduleRule(schedule({ payableUntil: new Date(NOW) }), NOW),
    ).toBe('payableUntil must be in the future');
  });

  test('refuses a payableUntil just past the horizon', () => {
    expect(
      brokenScheduleRule(
        schedule({ payableUntil: new Date(NOW + expectedHorizon + 1) }),
        NOW,
      ),
    ).toBe('payableUntil must be at most 62 days ahead');
  });
});

describe('the create schema', () => {
  const body = {
    externalUserId: 'sp:1',
    amount: 5000,
    currency: 1,
    period: 'P1M',
  };
  const decode = Schema.decodeUnknownEither(CreateCheckoutSession);

  test('decodes startsAt and payableUntil from ISO-8601 strings', () => {
    const decoded = decode({
      ...body,
      startsAt: '2026-12-01T00:00:00Z',
      payableUntil: '2026-11-20T12:00:00Z',
    });

    expect(Either.getOrThrow(decoded)).toMatchObject({
      startsAt: new Date('2026-12-01T00:00:00Z'),
      payableUntil: new Date('2026-11-20T12:00:00Z'),
    });
  });

  test('refuses a startsAt that is not a date', () => {
    expect(Either.isLeft(decode({ ...body, startsAt: 'soon' }))).toBe(true);
  });

  test('lockMethod without a method is refused', () => {
    expect(Either.isLeft(decode({ ...body, lockMethod: true }))).toBe(true);
  });

  test('lockMethod with a method decodes', () => {
    expect(
      Either.getOrThrow(
        decode({ ...body, lockMethod: true, method: PaymentMethod.Crypto }),
      ).lockMethod,
    ).toBe(true);
  });
});

interface Writes {
  reissued: NewCheckoutSession[];
  claimed: string[];
  released: string[];
}

const repoWith = (
  rows: CheckoutSession[],
): { repo: CheckoutRepo; writes: Writes } => {
  const writes: Writes = { reissued: [], claimed: [], released: [] };
  const repo = {
    findById: (id: string) =>
      Effect.sync(() => Option.fromNullable(rows.find((r) => r.id === id))),
    reissueLapsed: (input: NewCheckoutSession) =>
      Effect.sync(() => {
        writes.reissued.push(input);
        return input.id;
      }),
    claimForPayment: (id: string) =>
      Effect.sync(() => {
        writes.claimed.push(id);
        return true;
      }),
    releasePending: (id: string) =>
      Effect.sync(() => {
        writes.released.push(id);
      }),
    everSentToProvider: die,
    findByIdempotencyKey: die,
    insert: die,
    completeIfOpen: die,
    renameOpenSessionsExternalUser: die,
  } as unknown as CheckoutRepo;
  return { repo, writes };
};

const noSub = () => Effect.succeed(Option.none<Payment>());

const resolve = (repo: CheckoutRepo, method: number = PaymentMethod.Card) =>
  Effect.runSync(
    resolvePayableSessionId(
      { sessions: repo, findActiveRecurring: noSub },
      'chk_old',
      { method },
      NOW,
      TTL_SECONDS,
    ).pipe(Effect.either),
  );

const leftOf = (result: Either.Either<unknown, unknown>) =>
  Either.isLeft(result) ? result.left : null;

describe('a bounded offer at /pay', () => {
  test('before it closes it is paid as-is', () => {
    const result = effectivePayable(
      bounded(new Date(NOW + MINUTE)),
      Option.none(),
      NOW,
      TTL_SECONDS,
    );

    expect(Either.getOrThrow(result)._tag).toBe('Stored');
  });

  test('at the instant it closes it is refused as closed (410)', () => {
    const closesAt = new Date(NOW);
    const result = effectivePayable(
      bounded(closesAt),
      Option.none(),
      NOW,
      TTL_SECONDS,
    );

    const refusal = leftOf(result);
    expect(refusal).toMatchObject({
      _tag: 'CheckoutClosed',
      payableUntil: closesAt,
    });
    expect(
      (refusal as { toHttp: () => { status: number } }).toHttp().status,
    ).toBe(410);
  });
});

describe('a lapsed bounded offer at /pay', () => {
  test('a lapsed bounded session is closed, never re-issued: no new session row', () => {
    const { repo, writes } = repoWith([bounded(new Date(NOW - HOUR))]);

    const result = resolve(repo);

    expect(leftOf(result)).toMatchObject({ _tag: 'CheckoutClosed' });
    expect(writes).toEqual({ reissued: [], claimed: [], released: [] });
  });

  test('a bounded session marked Expired is closed even before payableUntil', () => {
    const { repo, writes } = repoWith([
      bounded(new Date(NOW + HOUR), { status: CheckoutSessionStatus.Expired }),
    ]);

    const result = resolve(repo);

    expect(leftOf(result)).toMatchObject({ _tag: 'CheckoutClosed' });
    expect(writes.reissued).toEqual([]);
  });

  test('a live Pending bounded session is released and paid again under the same id', () => {
    const { repo, writes } = repoWith([
      bounded(new Date(NOW + HOUR), { status: CheckoutSessionStatus.Pending }),
    ]);

    const result = resolve(repo);

    expect(Either.getOrThrow(result)).toBe('chk_old');
    expect(writes.released).toEqual(['chk_old']);
    expect(writes.reissued).toEqual([]);
  });

  test('the claim refuses a closed row too, without claiming it', () => {
    const { repo, writes } = repoWith([
      session({ payableUntil: new Date(NOW - 1) }),
    ]);

    const result = Effect.runSync(
      claimPayableSession(
        { sessions: repo, findActiveRecurring: noSub },
        'chk_old',
        { method: PaymentMethod.Card },
        NOW,
      ).pipe(Effect.either),
    );

    expect(leftOf(result)).toMatchObject({ _tag: 'CheckoutClosed' });
    expect(writes.claimed).toEqual([]);
  });

  test('an unbounded lapsed session is still re-issued as before', () => {
    const { repo, writes } = repoWith([
      session({ expiresAt: new Date(NOW - HOUR) }),
    ]);

    resolve(repo);

    expect(writes.reissued).toHaveLength(1);
  });
});

describe('lockMethod at /pay', () => {
  test('a locked session refuses a different method, nothing written', () => {
    const { repo, writes } = repoWith([
      session({ lockMethod: true, method: PaymentMethod.Crypto }),
    ]);

    const result = resolve(repo, PaymentMethod.Card);

    expect(leftOf(result)).toMatchObject({
      _tag: 'MethodLocked',
      method: PaymentMethod.Crypto,
    });
    expect(writes).toEqual({ reissued: [], claimed: [], released: [] });
  });

  test('a locked session accepts its own method', () => {
    const { repo } = repoWith([
      session({ lockMethod: true, method: PaymentMethod.Crypto }),
    ]);

    expect(Either.getOrThrow(resolve(repo, PaymentMethod.Crypto))).toBe(
      'chk_old',
    );
  });

  test('an unlocked caller session takes either method', () => {
    const { repo } = repoWith([session({ method: PaymentMethod.Crypto })]);

    expect(Either.getOrThrow(resolve(repo, PaymentMethod.Card))).toBe(
      'chk_old',
    );
  });

  test('a lapsed locked session is cloned still locked', () => {
    const { repo, writes } = repoWith([
      session({
        lockMethod: true,
        method: PaymentMethod.Crypto,
        expiresAt: new Date(NOW - HOUR),
        startsAt: new Date(NOW + DAY),
      }),
    ]);

    resolve(repo, PaymentMethod.Crypto);

    expect(writes.reissued[0]).toMatchObject({
      lockMethod: true,
      method: PaymentMethod.Crypto,
      startsAt: new Date(NOW + DAY),
    });
  });
});

describe('the idempotent create replay', () => {
  const intent = (startsAt: Date | null): NewCheckoutSession => ({
    ...session({ id: 'chk_new', startsAt }),
    method: PaymentMethod.Card,
  });

  const replayRepo = (existing: CheckoutSession) =>
    ({
      insert: () => Effect.succeed(false),
      everSentToProvider: die,
      findByIdempotencyKey: () => Effect.succeed(Option.some(existing)),
    }) as unknown as CheckoutRepo;

  const replay = (existing: CheckoutSession, input: NewCheckoutSession) =>
    Effect.runSync(
      insertOrReplay(replayRepo(existing), input, 'https://pay').pipe(
        Effect.either,
      ),
    );

  test('a different startsAt under the same key is a conflict', () => {
    const result = replay(
      session({ startsAt: new Date(NOW + DAY) }),
      intent(new Date(NOW + 2 * DAY)),
    );

    expect(leftOf(result)).toMatchObject({ _tag: 'Conflict' });
  });

  test('a startsAt added on retry is a conflict', () => {
    const result = replay(session(), intent(new Date(NOW + DAY)));

    expect(leftOf(result)).toMatchObject({ _tag: 'Conflict' });
  });

  test('the same startsAt replays the stored session', () => {
    const result = replay(
      session({ startsAt: new Date(NOW + DAY) }),
      intent(new Date(NOW + DAY)),
    );

    expect(Either.getOrThrow(result).sessionId).toBe('chk_old');
  });
});
