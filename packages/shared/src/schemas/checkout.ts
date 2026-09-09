import { Schema } from 'effect';

import {
  CurrencySchema,
  PaymentMethod,
  PaymentMethodSchema,
} from '@/schemas/payment.js';

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

/**
 * A browser redirect target the caller may attach to a checkout. Constrained to an
 * http(s) URL at the API boundary so a stored target can never be a `javascript:` (or
 * other scheme) open-redirect the return page would navigate to. Persisted rows read
 * back as a plain string — the scheme is enforced on write, not on every read.
 */
export const RedirectUrl = Schema.String.pipe(
  Schema.filter((s) => /^https?:\/\//i.test(s), {
    message: () => 'must be an http(s) URL',
  }),
);

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
  // false for a one-time checkout: its payment is created fresh (not extended), stores
  // no reusable token, and is never scheduled or renewed. Default true (subscription).
  recurring: Schema.Boolean,
  // The payment a card-change session re-tokenizes; null for a normal checkout.
  paymentId: Schema.NullOr(Schema.String),
  // Where the return page sends the browser once the webhook resolves the payment:
  // `successUrl` on confirmation, `failureUrl` on decline/timeout. Null falls back to
  // the built-in return-page message. The provider redirect still lands on our return
  // page first, so state is always reconciled from the webhook, never the redirect.
  successUrl: Schema.NullOr(Schema.String),
  failureUrl: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  createdAt: Schema.Date,
});

export type CheckoutSession = Schema.Schema.Type<typeof CheckoutSession>;

/** Insert params: the server owns status/createdAt. `method` is the default preselected
 * at creation (Card unless the create request said otherwise); optional so a session may
 * still be inserted without a preselected method (it is then chosen on the page). */
export const NewCheckoutSession = CheckoutSession.pipe(
  Schema.omit('method', 'status', 'createdAt'),
  Schema.extend(
    Schema.Struct({ method: Schema.optional(PaymentMethodSchema) }),
  ),
);

export type NewCheckoutSession = Schema.Schema.Type<typeof NewCheckoutSession>;

/** The stored `period` for a one-time checkout, which has no renewal cadence. A valid
 * zero-length ISO-8601 duration: it satisfies the NOT NULL `period` columns and is never
 * parsed (only recurring renewals call `addPeriod`), so a one-time never reads it back. */
export const ONE_TIME_PERIOD = 'P0D';

/** POST /api/checkout-sessions body (docs/06): the external system's intent. `method`
 * is the default payment method preselected on the checkout page; optional on the wire
 * and defaulted to Card (PaymentMethod.Card) when the caller omits it. `recurring`
 * defaults to true (a subscription) — a caller opts a one-time payment in with `false`.
 * `period` (ISO-8601 duration) is the renewal cadence: required for a recurring checkout,
 * omitted for a one-time purchase (it never renews). `successUrl`/`failureUrl` are
 * optional post-payment browser redirects (http(s) only). */
export const CreateCheckoutSession = CheckoutSession.pipe(
  Schema.pick('externalUserId', 'amount', 'currency'),
  Schema.extend(
    Schema.Struct({
      period: Schema.optional(Schema.String),
      method: Schema.optionalWith(PaymentMethodSchema, {
        default: () => PaymentMethod.Card,
      }),
      recurring: Schema.optionalWith(Schema.Boolean, { default: () => true }),
      successUrl: Schema.optional(RedirectUrl),
      failureUrl: Schema.optional(RedirectUrl),
    }),
  ),
  // A recurring checkout needs its renewal cadence; a one-time purchase never renews, so
  // `period` may be omitted there (the server stores ONE_TIME_PERIOD instead).
  Schema.filter(
    (v) =>
      !v.recurring || (typeof v.period === 'string' && v.period.length > 0),
    { message: () => 'period is required for a recurring checkout' },
  ),
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
 * amount/currency/period/status/kind/method/expiresAt only — no externalUserId so
 * subscriber data does not appear on the public checkout page. `kind` lets the checkout
 * page tell a 0-amount card-change (verify widget) from a priced Purchase; `method` is
 * the default the page preselects in its method picker.
 */
export const CheckoutSessionPublic = CheckoutSession.pipe(
  Schema.pick(
    'amount',
    'currency',
    'period',
    'status',
    'kind',
    'method',
    'successUrl',
    'failureUrl',
    'expiresAt',
  ),
);

export type CheckoutSessionPublic = Schema.Schema.Type<
  typeof CheckoutSessionPublic
>;

/**
 * A WayForPay hosted-purchase form the frontend POSTs to the provider directly
 * (`kind: 'form'` so a provider whose handoff is a redirect, not a form POST, is a
 * distinct union member rather than an overloaded shape).
 */
export const PurchaseForm = Schema.Struct({
  kind: Schema.Literal('form'),
  action: Schema.String,
  fields: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export type PurchaseForm = Schema.Schema.Type<typeof PurchaseForm>;

/**
 * A hosted-checkout redirect the frontend navigates to (WhitePay: we mint a crypto
 * order server-side and hand back its `acquiring_url`). The browser GETs `url` — no
 * form fields, no client-side signing.
 */
export const RedirectInstruction = Schema.Struct({
  kind: Schema.Literal('redirect'),
  url: Schema.String,
});

export type RedirectInstruction = Schema.Schema.Type<
  typeof RedirectInstruction
>;

/**
 * POST /api/checkout-sessions/:id/pay response, discriminated on `kind`: a card
 * method hands back a `form` to POST to WayForPay; a crypto method hands back a
 * `redirect` to the WhitePay hosted page. A new provider adds a member, not a field.
 */
export const PayInstruction = Schema.Union(PurchaseForm, RedirectInstruction);

export type PayInstruction = Schema.Schema.Type<typeof PayInstruction>;
