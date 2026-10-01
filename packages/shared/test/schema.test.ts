import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { CreateCheckoutSession } from '@/schemas/checkout.js';
import {
  CreatePayment,
  Currency,
  Payment,
  PaymentMethod,
  PaymentStatus,
} from '@/schemas/payment.js';

const validPayment = {
  id: 'sub_1',
  externalUserId: 'sendpulse:1',
  amount: 30000,
  currency: Currency.UAH,
  method: PaymentMethod.Card,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: '2025-12-15T00:00:00.000Z',
  currentPeriodEnd: '2026-01-15T00:00:00.000Z',
  nextPaymentDate: '2026-01-15T00:00:00.000Z',
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const createParams = {
  externalUserId: validPayment.externalUserId,
  amount: validPayment.amount,
  currency: validPayment.currency,
  method: validPayment.method,
  period: validPayment.period,
  status: validPayment.status,
  recurring: validPayment.recurring,
  currentPeriodStart: validPayment.currentPeriodStart,
  currentPeriodEnd: validPayment.currentPeriodEnd,
  nextPaymentDate: validPayment.nextPaymentDate,
  recurringTokenRef: validPayment.recurringTokenRef,
  firstFailureAt: validPayment.firstFailureAt,
  retryAttempt: validPayment.retryAttempt,
};

it.effect('decodes a valid payment', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(Payment)(validPayment);
    expect(decoded.method).toBe(PaymentMethod.Card);
  }),
);

it.effect('rejects an invalid payment', () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Schema.decodeUnknown(Payment)({ id: 'x' }),
    );
    expect(result._tag).toBe('Failure');
  }),
);

it.effect('CreatePayment is the entity without id (computed from schema)', () =>
  Effect.gen(function* () {
    // CreatePayment decodes id-less params and yields no `id`...
    const created = yield* Schema.decodeUnknown(CreatePayment)(createParams);
    expect(created).not.toHaveProperty('id');
    // ...while the full Payment requires an `id`.
    const missingId = yield* Effect.exit(
      Schema.decodeUnknown(Payment)(createParams),
    );
    expect(missingId._tag).toBe('Failure');
  }),
);

const baseCheckout = {
  externalUserId: 'guildmaster:1',
  amount: 899,
  currency: Currency.USD,
  method: PaymentMethod.Card,
};

it.effect('CreateCheckoutSession: a one-time purchase may omit period', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(CreateCheckoutSession)({
      ...baseCheckout,
      recurring: false,
    });
    expect(decoded.recurring).toBe(false);
    expect(decoded.period).toBeUndefined();
  }),
);

it.effect('CreateCheckoutSession: a recurring checkout requires period', () =>
  Effect.gen(function* () {
    // `recurring` defaults to true, so an omitted period must be rejected.
    const missingDefault = yield* Effect.exit(
      Schema.decodeUnknown(CreateCheckoutSession)(baseCheckout),
    );
    expect(missingDefault._tag).toBe('Failure');
    // ...and an explicit `recurring: true` with no period is likewise rejected.
    const missingExplicit = yield* Effect.exit(
      Schema.decodeUnknown(CreateCheckoutSession)({
        ...baseCheckout,
        recurring: true,
      }),
    );
    expect(missingExplicit._tag).toBe('Failure');
    // A recurring checkout WITH a period decodes fine.
    const ok = yield* Schema.decodeUnknown(CreateCheckoutSession)({
      ...baseCheckout,
      recurring: true,
      period: 'P1M',
    });
    expect(ok.period).toBe('P1M');
  }),
);
