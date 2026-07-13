import { it } from '@effect/vitest';
import type { Subscription } from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { expect } from 'vitest';

import type {
  IncomingPaymentEvent,
  PaymentEventStatus,
} from '@/modules/payments/contracts.js';
import type { SubscriptionRepo } from '@/modules/subscription/data-access.js';
import { makeRecurringMatcher } from '@/modules/subscription/matcher.js';

const sub: Subscription = {
  id: '11111111-1111-1111-1111-111111111111',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: 0,
  nextChargeDate: new Date(0),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const die = () => Effect.die('unused');
const repo = (found: Subscription | null): SubscriptionRepo => ({
  findById: () =>
    Effect.succeed(found === null ? Option.none() : Option.some(found)),
  findActiveByExternalUser: die,
  findDue: die,
  insert: die,
  extend: die,
  advanceAfterSuccess: die,
  recordRetry: die,
  markRenewalFailed: die,
});

const event = (
  externalRef: string,
  status: PaymentEventStatus = 'succeeded',
): IncomingPaymentEvent => ({
  source: 'wayforpay_charge',
  idemKey: 'k',
  externalRef,
  externalUserId: null,
  amount: 30000,
  currency: 0,
  status,
  occurredAt: new Date(0),
  payload: {},
});

it.effect('matches our sub_<id>_ orderReference to the subscription', () =>
  makeRecurringMatcher(repo(sub))
    .match(event(`sub_${sub.id}_1700000000`))
    .pipe(
      Effect.map((result) => {
        expect(result.matched).toBe(true);
        if (result.matched) {
          expect(result.kind).toBe('recurring');
          expect(result.subscriptionId).toBe(sub.id);
        }
      }),
    ),
);

it.effect('does not match a legacy _WFPREG reference', () =>
  makeRecurringMatcher(repo(sub))
    .match(event('order_WFPREG-123-1'))
    .pipe(
      Effect.map((result) => {
        expect(result.matched).toBe(false);
      }),
    ),
);

it.effect('does not match a non-succeeded charge', () =>
  makeRecurringMatcher(repo(sub))
    .match(event(`sub_${sub.id}_1`, 'failed'))
    .pipe(
      Effect.map((result) => {
        expect(result.matched).toBe(false);
      }),
    ),
);
