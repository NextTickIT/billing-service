import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

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
  nextChargeDate: '2026-01-15T00:00:00.000Z',
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
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
  nextChargeDate: validPayment.nextChargeDate,
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
