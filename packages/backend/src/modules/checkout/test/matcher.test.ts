import { it } from '@effect/vitest';
import type { CheckoutSession } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type { CheckoutRepo } from '@/modules/checkout/data-access.js';
import { makeCheckoutMatcher } from '@/modules/checkout/matcher.js';
import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';

const session: CheckoutSession = {
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  period: 'P1M',
  method: 0,
  status: 1,
  expiresAt: new Date(0),
  createdAt: new Date(0),
};

const repoWith = (found: CheckoutSession | null): CheckoutRepo => ({
  findById: () =>
    Effect.succeed(found === null ? Option.none() : Option.some(found)),
  insert: () => Effect.void,
  setPending: () => Effect.void,
  markCompleted: () => Effect.void,
});

const event = (over: Partial<IncomingPaymentEvent>): IncomingPaymentEvent => ({
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
  makeCheckoutMatcher(repoWith(session))(event({})).pipe(
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

it.effect('does not match a non-succeeded event', () =>
  makeCheckoutMatcher(repoWith(session))(event({ status: 'failed' })).pipe(
    Effect.map((result) => {
      expect(result.matched).toBe(false);
    }),
  ),
);

it.effect('does not match an unknown order reference', () =>
  makeCheckoutMatcher(repoWith(null))(event({})).pipe(
    Effect.map((result) => {
      expect(result.matched).toBe(false);
    }),
  ),
);
