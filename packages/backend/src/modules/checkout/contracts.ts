import {
  type Currency,
  CurrencySchema,
  PaymentMethodSchema,
} from '@billing-service/shared';
import { Schema } from 'effect';

/**
 * Checkout contracts (docs/05/06). The session id doubles as the WayForPay
 * orderReference, so the callback matches back to it. status: 0=created (link
 * issued) 1=pending (paying at provider) 2=completed 3=expired.
 */
export enum CheckoutSessionStatus {
  Created = 0,
  Pending = 1,
  Completed = 2,
  Expired = 3,
}

/** A checkout session at rest. `method` is null until chosen on the page. */
export interface CheckoutSession {
  readonly id: string;
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly period: string;
  readonly method: number | null;
  readonly status: CheckoutSessionStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** POST /api/checkout-sessions body (docs/06): the external system's intent. */
export const CreateCheckoutSession = Schema.Struct({
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  period: Schema.String,
});

export type CreateCheckoutSession = Schema.Schema.Type<
  typeof CreateCheckoutSession
>;

/** POST /api/checkout-sessions/:id/pay body: the method the user chose. */
export const SelectMethod = Schema.Struct({
  method: PaymentMethodSchema,
});

export type SelectMethod = Schema.Schema.Type<typeof SelectMethod>;
