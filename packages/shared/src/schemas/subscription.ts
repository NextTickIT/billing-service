import { Schema } from 'effect';

import { PaymentMethodSchema } from '@/enums/payment-method.js';

/**
 * Single source of truth for the Subscription contract.
 *
 * The static type is DERIVED from this schema — never hand-written. The same
 * shape is used at db, backend, and frontend with no transformation: encode /
 * decode only validates at boundaries, it never remaps fields.
 *
 * (Reference schema demonstrating the pattern — not the full billing domain.)
 */
export const Subscription = Schema.Struct({
  id: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int, // integer minimal currency units
  currency: Schema.String,
  method: PaymentMethodSchema,
});

export type Subscription = Schema.Schema.Type<typeof Subscription>;

/**
 * Computed contract: create params = the entity without its server-owned `id`.
 * Derived from the schema via `Schema.omit`, so it can never drift.
 */
export const CreateSubscription = Subscription.pipe(Schema.omit('id'));

export type CreateSubscription = Schema.Schema.Type<typeof CreateSubscription>;
