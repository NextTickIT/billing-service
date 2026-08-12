import { Schema } from 'effect';

import { CurrencySchema, PaymentMethodSchema } from '@/schemas/payment.js';

/**
 * Checkout session (docs/05/06). The session id doubles as the WayForPay
 * orderReference, so the callback matches back to it. status: 0=created (link
 * issued) 1=pending (paying at provider) 2=completed 3=expired. Owned by the
 * checkout slice; the id is the single source of truth every layer shares.
 */
export enum CheckoutSessionStatus {
  Created = 0,
  Pending = 1,
  Completed = 2,
  Expired = 3,
}

export const CheckoutSessionStatusSchema = Schema.Enums(CheckoutSessionStatus);

/**
 * What a session is for. `Checkout` is the normal first-payment flow; `CardChange`
 * re-tokenizes an existing payment (0-amount verify when current, or a priced
 * Purchase for the owed amount when behind) and its callback updates that payment
 * rather than creating one. Numeric at rest. Owned by the checkout slice.
 */
export enum CheckoutSessionKind {
  Checkout = 0,
  CardChange = 1,
}

export const CheckoutSessionKindSchema = Schema.Enums(CheckoutSessionKind);

/** A checkout session at rest. `method` is null until chosen on the page. */
export const CheckoutSession = Schema.Struct({
  id: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  period: Schema.String,
  method: Schema.NullOr(PaymentMethodSchema),
  status: CheckoutSessionStatusSchema,
  kind: CheckoutSessionKindSchema,
  // The payment a card-change session re-tokenizes; null for a normal checkout.
  paymentId: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  createdAt: Schema.Date,
});

export type CheckoutSession = Schema.Schema.Type<typeof CheckoutSession>;

/** Insert params: the server owns status/createdAt; the method is chosen later. */
export const NewCheckoutSession = CheckoutSession.pipe(
  Schema.omit('method', 'status', 'createdAt'),
);

export type NewCheckoutSession = Schema.Schema.Type<typeof NewCheckoutSession>;

/** POST /api/checkout-sessions body (docs/06): the external system's intent. */
export const CreateCheckoutSession = CheckoutSession.pipe(
  Schema.pick('externalUserId', 'amount', 'currency', 'period'),
);

export type CreateCheckoutSession = Schema.Schema.Type<
  typeof CreateCheckoutSession
>;

/** POST /api/checkout-sessions/:id/pay body: the method the user chose. */
export const SelectMethod = Schema.Struct({
  method: PaymentMethodSchema,
});

export type SelectMethod = Schema.Schema.Type<typeof SelectMethod>;

/** POST /api/checkout-sessions response: the issued link and its expiry. */
export const SessionCreated = Schema.Struct({
  sessionId: Schema.String,
  checkoutUrl: Schema.String,
  expiresAt: Schema.Date,
});

export type SessionCreated = Schema.Schema.Type<typeof SessionCreated>;

/**
 * POST /api/payment/card-change body (docs/23): SendPulse initiates a card change
 * for a user; the server resolves the one recurrent payment and issues a
 * card-change checkout link. Reuses `SessionCreated` as the response.
 */
export const CardChangeRequest = Schema.Struct({
  externalUserId: Schema.String,
});

export type CardChangeRequest = Schema.Schema.Type<typeof CardChangeRequest>;

/**
 * GET /api/checkout-sessions/:id response (public, BFF-proxied, AC-9):
 * amount/currency/period/status/expiresAt only — no externalUserId so subscriber
 * data does not appear on the public checkout page.
 */
export const CheckoutSessionPublic = CheckoutSession.pipe(
  Schema.pick('amount', 'currency', 'period', 'status', 'expiresAt'),
);

export type CheckoutSessionPublic = Schema.Schema.Type<
  typeof CheckoutSessionPublic
>;

/**
 * POST /api/checkout-sessions/:id/pay response: WayForPay hosted-purchase form
 * fields that the frontend posts to the provider directly.
 */
export const PurchaseForm = Schema.Struct({
  action: Schema.String,
  fields: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export type PurchaseForm = Schema.Schema.Type<typeof PurchaseForm>;
