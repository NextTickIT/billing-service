import { it } from '@effect/vitest';
import {
  type CheckoutPromo,
  type CheckoutSession,
  CheckoutSessionKind,
  type CreatePayment,
  type Payment,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { Charge } from '@/modules/charge/contracts.js';
import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  makeCheckoutApplier,
  makeCheckoutMatcher,
} from '@/modules/checkout/domain.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod, isValidPeriod } from '@/modules/payment/period.js';

/**
 * Local integration test for `promo.additionalFreePeriod: "P0D"` — the "no bonus days"
 * value. Wires the REAL checkout matcher + applier + payment domain together (only the
 * two repos are stubbed) and drives a paid checkout that carries the promo end-to-end:
 * matcher lifts `session.promo.additionalFreePeriod` into the match, the applier feeds it
 * to create-or-extend, and `periodAnchors` applies it. We assert P0D adds ZERO days
 * (paid-through unchanged) and is byte-for-byte the same billing outcome as no promo at
 * all, while a real bonus (P7D) genuinely moves the anchor — so P0D's no-op is proven,
 * not a dead branch.
 */

const PAID_AT = new Date('2026-01-15T00:00:00Z');
const PERIOD = 'P1M';
const PAID_THROUGH = addPeriod(PAID_AT, PERIOD); // 2026-02-15 — one paid month, no bonus

const event: Charge = {
  source: 'wayforpay_callback',
  idemKey: 'k',
  externalRef: 'chk_1',
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: PAID_AT,
  payload: { recToken: 'tok' },
};

const sessionWith = (promo: CheckoutPromo | null): CheckoutSession => ({
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  period: PERIOD,
  method: 0,
  status: 1,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo,
  idempotencyKey: null,
  expiresAt: new Date(0),
  createdAt: new Date(0),
});

/** Every unused repo method dies, so an unexpected code path fails the test loudly. */
const deadPayments: PaymentRepo = {
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
  cancelUpstream: () => Effect.die('unused'),
  defer: () => Effect.die('unused'),
  updateToken: () => Effect.die('unused'),
  setMethod: () => Effect.die('unused'),
  clearToken: () => Effect.die('unused'),
  renameExternalUser: () => Effect.die('unused'),
};

/** Run the real matcher→applier chain for a session carrying `promo`, and return the
 * Payment the applier inserted (the row the DB would persist). */
const insertedFor = (promo: CheckoutPromo | null) =>
  Effect.gen(function* () {
    let inserted: CreatePayment | null = null;
    const payments: PaymentRepo = {
      ...deadPayments,
      // A brand-new subscriber: nothing to extend, so the applier inserts.
      findActiveRecurringByExternalUser: () => Effect.succeed(Option.none()),
      insert: (input) =>
        Effect.sync(() => {
          inserted = input;
          return {
            ...input,
            id: 'sub_1',
            cancelRequestedAt: null,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          } satisfies Payment;
        }),
    };
    const checkout: CheckoutRepo = {
      findById: () => Effect.succeed(Option.some(sessionWith(promo))),
      findByIdempotencyKey: () => Effect.succeed(Option.none()),
      insert: () => Effect.succeed(true),
      claimForPayment: () => Effect.succeed(false),
      releasePending: () => Effect.void,
      markCompleted: () => Effect.void,
      renameOpenSessionsExternalUser: () => Effect.succeed(0),
    };

    // The real pipeline: match the paid event to the session, then apply it.
    const match = yield* makeCheckoutMatcher(checkout)(event);
    expect(match.matched).toBe(true);
    if (!match.matched) {
      return null;
    }
    // The matcher lifted the promo out of the session onto the match.
    expect(match.promoBonus).toBe(promo?.additionalFreePeriod ?? null);

    const result = yield* makeCheckoutApplier(payments, checkout)(event, match);
    expect(result.created).toBe(true);

    expect(inserted).not.toBeNull();
    return inserted as CreatePayment | null;
  });

it('accepts "P0D" at the API gate and rejects an empty value', () => {
  // `assertPromo` (checkout/routes.ts) gates the create request on exactly this predicate:
  // pass → 201, fail → 422 `unsupported promo period`.
  expect(isValidPeriod('P0D')).toBe(true); // accepted (201)
  expect(isValidPeriod('P7D')).toBe(true); // accepted (201)
  expect(isValidPeriod('')).toBe(false); // rejected (422) — do NOT send ""
  expect(isValidPeriod('P')).toBe(false); // rejected (422)
});

it.effect('a "P0D" promo adds zero days — paid-through is the plain period end', () =>
  Effect.gen(function* () {
    const inserted = yield* insertedFor({ additionalFreePeriod: 'P0D' });
    // Zero bonus: the paid-through anchor is exactly paidAt + period, no extra days.
    expect(inserted?.currentPeriodEnd).toEqual(PAID_THROUGH);
    expect(inserted?.nextPaymentDate).toEqual(PAID_THROUGH);
    expect(inserted?.currentPeriodStart).toEqual(PAID_AT);
  }),
);

it.effect('"P0D" is the same billing outcome as attaching no promo at all', () =>
  Effect.gen(function* () {
    const withP0D = yield* insertedFor({ additionalFreePeriod: 'P0D' });
    const withNone = yield* insertedFor(null);
    expect(withP0D?.currentPeriodEnd).toEqual(withNone?.currentPeriodEnd);
    expect(withP0D?.nextPaymentDate).toEqual(withNone?.nextPaymentDate);
  }),
);

it.effect('control: a real "P7D" bonus DOES move the anchor (P0D is a no-op, not dead code)', () =>
  Effect.gen(function* () {
    const inserted = yield* insertedFor({ additionalFreePeriod: 'P7D' });
    // 7 free days ON TOP of the paid month → anchor pushed a week past paid-through.
    expect(inserted?.currentPeriodEnd).toEqual(addPeriod(PAID_THROUGH, 'P7D'));
    expect(inserted?.currentPeriodEnd).not.toEqual(PAID_THROUGH);
  }),
);
