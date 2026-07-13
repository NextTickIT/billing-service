import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import {
  CreateSubscription,
  Currency,
  PaymentMethod,
  Subscription,
} from '@/schemas/subscription.js';

it.effect('decodes a valid subscription', () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(Subscription)({
      id: 'sub_1',
      externalUserId: 'sendpulse:1',
      amount: 30000,
      currency: Currency.UAH,
      method: PaymentMethod.Card,
    });
    expect(decoded.method).toBe(PaymentMethod.Card);
  }),
);

it.effect('rejects an invalid subscription', () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Schema.decodeUnknown(Subscription)({ id: 'x' }),
    );
    expect(result._tag).toBe('Failure');
  }),
);

it.effect(
  'CreateSubscription is the entity without id (computed from schema)',
  () =>
    Effect.gen(function* () {
      const params = {
        externalUserId: 'sendpulse:1',
        amount: 30000,
        currency: Currency.UAH,
        method: PaymentMethod.Card,
      };
      // CreateSubscription decodes id-less params and yields no `id`...
      const created = yield* Schema.decodeUnknown(CreateSubscription)(params);
      expect(created).not.toHaveProperty('id');
      // ...while the full Subscription requires an `id`.
      const missingId = yield* Effect.exit(
        Schema.decodeUnknown(Subscription)(params),
      );
      expect(missingId._tag).toBe('Failure');
    }),
);
