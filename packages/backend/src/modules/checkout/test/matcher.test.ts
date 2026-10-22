import { it } from '@effect/vitest';
import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type Payment,
} from '@billing-service/shared';
import { Effect, Logger, Option } from 'effect';
import { expect } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import { makeCheckoutMatcher } from '@/modules/checkout/domain.js';
import type { Charge } from '@/modules/charge/contracts.js';

const session: CheckoutSession = {
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  period: 'P1M',
  method: 0,
  status: 1,
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
  idempotencyKey: null,
  email: '',
  expiresAt: new Date(0),
  createdAt: new Date(0),
};

const repoWith = (found: CheckoutSession | null): CheckoutRepo => ({
  findById: () =>
    Effect.succeed(found === null ? Option.none() : Option.some(found)),
  findByIdempotencyKey: () => Effect.succeed(Option.none()),
  reissueLapsed: () => Effect.die('unexpected reissueLapsed'),
  insert: () => Effect.succeed(true),
  claimForPayment: () => Effect.succeed(false),
  releasePending: () => Effect.void,
  completeIfOpen: () => Effect.die('unused'),
  renameOpenSessionsExternalUser: () => Effect.succeed(0),
});

/** The contact holds no live recurring sub. */
const noLiveSub = () => Effect.succeed(Option.none<Payment>());

const event = (over: Partial<Charge>): Charge => ({
  source: 'wayforpay_callback',
  idemKey: 'k',
  externalRef: 'chk_1',
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date(0),
  payload: {},
  ...over,
});

it.effect('matches a succeeded event to a known session', () =>
  makeCheckoutMatcher(
    repoWith(session),
    noLiveSub,
  )(event({})).pipe(
    Effect.map((result) => {
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.kind).toBe('checkout');
        expect(result.externalUserId).toBe('sp:1');
        expect(result.period).toBe('P1M');
      }
    }),
  ),
);

it.effect(
  'matches a declined event to a known session (pipeline emits initial_payment_failed)',
  () =>
    makeCheckoutMatcher(
      repoWith(session),
      noLiveSub,
    )(event({ status: 'failed' })).pipe(
      Effect.map((result) => {
        expect(result.matched).toBe(true);
        if (result.matched) {
          expect(result.kind).toBe('checkout');
        }
      }),
    ),
);

it.effect('does not match an intermediate (pending) status', () =>
  makeCheckoutMatcher(
    repoWith(session),
    noLiveSub,
  )(event({ status: 'pending' })).pipe(
    Effect.map((result) => {
      expect(result.matched).toBe(false);
    }),
  ),
);

it.effect('does not match an unknown order reference', () =>
  makeCheckoutMatcher(
    repoWith(null),
    noLiveSub,
  )(event({})).pipe(
    Effect.map((result) => {
      expect(result.matched).toBe(false);
    }),
  ),
);

it.effect(
  'does not re-credit an already-completed session (crypto double-pay → quarantine)',
  () =>
    makeCheckoutMatcher(
      repoWith({ ...session, status: CheckoutSessionStatus.Completed }),
      noLiveSub,
    )(event({})).pipe(
      Effect.map((result) => {
        // A second success (or a late decline) for a completed session falls through to
        // quarantine — never a second create-or-extend or a spurious failure event.
        expect(result.matched).toBe(false);
      }),
    ),
);

// ---- Renewal terms, prolongOf and settlement anomalies (T9) ----

const liveSub = { id: 'sub_live' } as Payment;

/** A finder that records each call and returns `found`. */
const recordingFinder = (found: Payment | null) => {
  const calls: string[] = [];
  const find = (externalUserId: string) =>
    Effect.sync(() => {
      calls.push(externalUserId);
      return Option.fromNullable(found);
    });
  return { calls, find };
};

/** Run the matcher with a log capture, returning the result and the logged lines. */
const runLogged = (
  found: CheckoutSession | null,
  over: Partial<Charge>,
  finder = recordingFinder(null).find,
) =>
  Effect.gen(function* () {
    const logs: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push(`${logLevel.label} ${String(message)}`);
    });
    const result = yield* makeCheckoutMatcher(
      repoWith(found),
      finder,
    )(event(over)).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
    );
    return { result, logs };
  });

const prolongSessionRow: CheckoutSession = {
  ...session,
  renewal: { amount: 5000, period: 'P4W' },
  origin: 'manual_renewal',
  renewalOf: 'sub_dead',
  options: null,
};

it.effect(
  'passes the session terms, origin and renewalOf through without reading payments',
  () =>
    Effect.gen(function* () {
      const finder = recordingFinder(liveSub);
      const { result } = yield* runLogged(prolongSessionRow, {}, finder.find);

      expect(result).toMatchObject({
        matched: true,
        renewal: { amount: 5000, period: 'P4W' },
        origin: 'manual_renewal',
        renewalOf: 'sub_dead',
        prolongOf: null,
        amount: 30000,
        currency: 0,
      });
      // A succeeded charge never queries payments.
      expect(finder.calls).toEqual([]);
    }),
);

it.effect(
  'a declined recurring session with a live sub carries prolongOf',
  () =>
    Effect.gen(function* () {
      const finder = recordingFinder(liveSub);
      const { result } = yield* runLogged(
        session,
        { status: 'failed' },
        finder.find,
      );

      expect(result).toMatchObject({ matched: true, prolongOf: 'sub_live' });
      expect(finder.calls).toEqual(['sp:1']);
    }),
);

it.effect(
  'a declined session with no live sub, or a one-time one: no prolongOf',
  () =>
    Effect.gen(function* () {
      const none = yield* runLogged(session, { status: 'failed' });
      expect(none.result).toMatchObject({ matched: true, prolongOf: null });

      const finder = recordingFinder(liveSub);
      const oneTime = yield* runLogged(
        { ...session, recurring: false },
        { status: 'failed' },
        finder.find,
      );
      expect(oneTime.result).toMatchObject({ matched: true, prolongOf: null });
      expect(finder.calls).toEqual([]);
    }),
);

it.effect(
  'a currency mismatch quarantines with the SETTLEMENT_ANOMALY marker',
  () =>
    Effect.gen(function* () {
      const { result, logs } = yield* runLogged(session, { currency: 1 });

      expect(result.matched).toBe(false);
      expect(logs.some((l) => l.startsWith('ERROR SETTLEMENT_ANOMALY'))).toBe(
        true,
      );
    }),
);

it.effect(
  'an amount mismatch settles on the session price with only a warning',
  () =>
    Effect.gen(function* () {
      const { result, logs } = yield* runLogged(session, { amount: 29950 });

      expect(result).toMatchObject({ matched: true, amount: 30000 });
      expect(logs).toEqual(['WARN settlement: amount differs from session']);
    }),
);

it.effect('a succeeded charge on a completed session logs the marker', () =>
  Effect.gen(function* () {
    const { result, logs } = yield* runLogged(
      { ...session, status: CheckoutSessionStatus.Completed },
      {},
    );

    expect(result.matched).toBe(false);
    expect(logs.some((l) => l.includes('SETTLEMENT_ANOMALY'))).toBe(true);
  }),
);

it.effect('routine quarantines log no marker', () =>
  Effect.gen(function* () {
    const unknownRef = yield* runLogged(null, {});
    const pending = yield* runLogged(session, { status: 'pending' });
    const lateDecline = yield* runLogged(
      { ...session, status: CheckoutSessionStatus.Completed },
      { status: 'failed' },
    );

    for (const run of [unknownRef, pending, lateDecline]) {
      expect(run.result.matched).toBe(false);
      expect(run.logs).toEqual([]);
    }
  }),
);
