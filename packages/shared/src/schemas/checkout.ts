import { Schema } from 'effect';

import { isNonZeroPeriod, isValidPeriod, RecurringPeriod } from '@/period.js';
import {
  CurrencySchema,
  Metadata,
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
export const EmailAddress = Schema.String.pipe(
  Schema.filter((s) => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s), {
    message: () => 'must be an email address',
  }),
);

export const RedirectUrl = Schema.String.pipe(
  Schema.filter((s) => /^https?:\/\//i.test(s), {
    message: () => 'must be an http(s) URL',
  }),
);

/**
 * An optional promo attached to a checkout. `additionalFreePeriod` is an ISO-8601
 * duration in our period format (e.g. `P14D`, `P1M`) granted ON TOP of the paid period
 * when — and only when — this checkout is paid: it pushes the paid-through anchor (and
 * the next charge date derived from it) further, exactly once. It is a one-time bonus,
 * never re-applied on the later recurring renewals the scheduler drives.
 */
export const CheckoutPromo = Schema.Struct({
  additionalFreePeriod: Schema.String,
});

export type CheckoutPromo = Schema.Schema.Type<typeof CheckoutPromo>;

/**
 * The terms the subscription renews at when they differ from the first charge (an intro
 * price or an intro length). The first payment charges the top-level amount/period; the
 * stored subscription, and so every scheduler renewal, uses these. Both fields are
 * required when present; the currency is the checkout's.
 */
export const CheckoutRenewal = Schema.Struct({
  amount: Schema.Int.pipe(Schema.positive()),
  period: RecurringPeriod,
});

export type CheckoutRenewal = Schema.Schema.Type<typeof CheckoutRenewal>;

/**
 * Who minted a session, when it was not the external caller's create. Never accepted on
 * the wire and never exposed publicly (`card_change_arrears` would tell anyone holding
 * the link that the customer owes money). Null means a caller-created checkout, or a
 * session minted before the column existed.
 * - `prolong`: `POST /api/payment/prolong`; its method is locked to the sub's.
 * - `manual_renewal`: the scheduler's manual (crypto) renewal prompt.
 * - `card_change` / `card_change_arrears`: a card change that does not / does collect
 *   an owed period.
 */
export const CheckoutOrigin = Schema.Literal(
  'prolong',
  'manual_renewal',
  'card_change',
  'card_change_arrears',
);

export type CheckoutOrigin = Schema.Schema.Type<typeof CheckoutOrigin>;

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
  // Optional one-time promo; null when the caller attached none. Consumed once, when the
  // session is paid, to extend the paid-through anchor (see CheckoutPromo).
  promo: Schema.NullOr(CheckoutPromo),
  // Opt-in dedup key from the caller's `Idempotency-Key` header (null when absent). A
  // unique index enforces one session per key, so a retried/parallel create returns the
  // same session instead of minting a duplicate. Never exposed on the public session.
  idempotencyKey: Schema.NullOr(Schema.String),
  // The payer's email, captured at checkout, for the transactional receipt. Empty
  // string when the caller did not supply one — the column is NOT NULL DEFAULT ''.
  //
  // It lives on the purchase rather than on the contact cache because a receipt must
  // reach a FIRST-TIME buyer: they have no SendPulse chatbot contact (one exists only
  // after they message the bot, and no API can create it), so the id billing holds is
  // unreachable at exactly the moment they have paid. Email needs only an address.
  email: Schema.String,
  // Opaque caller passthrough (see `Metadata`): stamped onto the payment when this
  // session is paid and echoed on the events that follow. Null when the caller sent none.
  metadata: Schema.NullOr(Metadata),
  expiresAt: Schema.Date,
  createdAt: Schema.Date,
  // Renewal terms when they differ from the first charge; null renews at the top-level
  // amount/period (see CheckoutRenewal).
  renewal: Schema.NullOr(CheckoutRenewal),
  // Who minted the session (see CheckoutOrigin); internal only.
  origin: Schema.NullOr(CheckoutOrigin),
  // The subscription a `prolong` or `manual_renewal` session renews. Attribution only:
  // it never selects the row a payment writes; it names the sub in a decline event and
  // keeps one sub's replacement link from being handed to another. Internal only.
  renewalOf: Schema.NullOr(Schema.String),
});

export type CheckoutSession = Schema.Schema.Type<typeof CheckoutSession>;

/** Insert params: the server owns status/createdAt. `method` is the default preselected
 * at creation (Card unless the create request said otherwise); optional so a session may
 * still be inserted without a preselected method (it is then chosen on the page). */
export const NewCheckoutSession = CheckoutSession.pipe(
  Schema.omit('method', 'status', 'createdAt', 'metadata'),
  Schema.extend(
    Schema.Struct({
      method: Schema.optional(PaymentMethodSchema),
      // Optional AND nullable on insert: omitted or null both store NULL.
      metadata: Schema.optional(Schema.NullOr(Metadata)),
    }),
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
 * optional post-payment browser redirects (http(s) only). `promo`, if present, grants a
 * one-time bonus free period on top of the paid period when this checkout is paid. */
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
      promo: Schema.optional(CheckoutPromo),
      // Optional renewal terms when they differ from the first charge (recurring only).
      renewal: Schema.optional(CheckoutRenewal),
      // Optional: the receipt is sent only when an address was captured. Validated for
      // FORM at the boundary — a malformed address is worse than an absent one, because
      // it looks delivered and bounces silently.
      email: Schema.optional(EmailAddress),
      // Opaque passthrough. ABSENT and `{}` are different instructions: absent leaves
      // whatever the payment already carries, `{}` is a supplied value and replaces it.
      // A client that defaults this to `{}` therefore wipes the stored intent — send
      // nothing, not an empty object, when you mean "unchanged".
      metadata: Schema.optional(Metadata),
    }),
  ),
  // A recurring checkout needs its renewal cadence; a one-time purchase never renews, so
  // `period` may be omitted there (the server stores ONE_TIME_PERIOD instead).
  Schema.filter(
    (v) =>
      !v.recurring || (typeof v.period === 'string' && v.period.length > 0),
    { message: () => 'period is required for a recurring checkout' },
  ),
  // The rules below bind the external caller only. Internal minters (the 0-amount
  // card-change verify, the manual renewal, /prolong) insert sessions directly and never
  // decode through this schema.
  Schema.filter((v) => v.renewal === undefined || v.recurring, {
    message: () => 'renewal is only allowed on a recurring checkout',
  }),
  // A zero-length cadence would leave the next charge date in place, so the scheduler
  // would charge on every tick. A one-time purchase keeps accepting P0D/no period.
  Schema.filter(
    (v) =>
      !v.recurring ||
      (typeof v.period === 'string' &&
        isValidPeriod(v.period) &&
        isNonZeroPeriod(v.period)),
    {
      message: () =>
        'period must be a non-zero ISO-8601 duration for a recurring checkout',
    },
  ),
  // Recurring or one-time: an external caller never sells something for nothing. The
  // 0-amount card-change verify is internal and never decodes through here.
  Schema.filter((v) => v.amount > 0, {
    message: () => 'amount must be positive',
  }),
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
 * POST /api/payment/prolong body: SendPulse asks for a link that extends the user's live
 * (Active/PastDue) subscription by one period at its current terms. No redirects: the
 * link lands on the hosted pay page. Reuses `SessionCreated` as the response.
 */
export const ProlongRequest = Schema.Struct({
  externalUserId: Schema.String,
});

export type ProlongRequest = Schema.Schema.Type<typeof ProlongRequest>;

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
 * POST /api/payment/method-change body: switch the user's ONE recurring subscription to a
 * target payment method, agnostic to whatever it is now. `method` is the DESTINATION
 * (0=Card, 1=Crypto); the server resolves the user's recurring payment itself. Card→card
 * (re-tokenize), crypto→card, and card→crypto are all valid.
 */
export const MethodChangeRequest = Schema.Struct({
  externalUserId: Schema.String,
  method: PaymentMethodSchema,
});

export type MethodChangeRequest = Schema.Schema.Type<
  typeof MethodChangeRequest
>;

/**
 * POST /api/payment/method-change response, discriminated on `kind`:
 * - `checkout`: the change needs the user to pay/verify at a link — switching TO card
 *   always (a token can only be captured by the cardholder), and switching TO crypto while
 *   an amount is owed (the arrears are collected in crypto). Same fields as SessionCreated.
 * - `applied`: the change took effect server-side with no payment — an up-to-date
 *   subscription switching TO crypto just drops the stored card token and records crypto,
 *   so the next renewal becomes a manual crypto prompt (there is no free crypto verify).
 */
export const MethodChangeCheckout = Schema.Struct({
  kind: Schema.Literal('checkout'),
  // Same payload as SessionCreated (spread so the two can never drift), plus `kind`.
  ...SessionCreated.fields,
});

export type MethodChangeCheckout = Schema.Schema.Type<
  typeof MethodChangeCheckout
>;

export const MethodChangeApplied = Schema.Struct({
  kind: Schema.Literal('applied'),
  // Today only ever Crypto (the sole no-payment flip); typed as a method for future flips.
  method: PaymentMethodSchema,
});

export type MethodChangeApplied = Schema.Schema.Type<
  typeof MethodChangeApplied
>;

export const MethodChangeResult = Schema.Union(
  MethodChangeCheckout,
  MethodChangeApplied,
);

export type MethodChangeResult = Schema.Schema.Type<typeof MethodChangeResult>;

/**
 * GET /api/checkout-sessions/:id response (public, BFF-proxied, AC-9):
 * amount/currency/period/recurring/status/kind/method/expiresAt only — no
 * externalUserId so subscriber data does not appear on the public checkout page. `kind`
 * lets the checkout page tell a 0-amount card-change (verify widget) from a priced
 * Purchase; `method` is the default the page preselects in its method picker.
 * `recurring` is what the page tells the payer they are buying — a subscription that
 * renews every `period`, or a single charge — so a recurring authorisation is never
 * taken without disclosing it; `period` is a renewal cadence only when it is true.
 * `renewal` discloses the renewal terms when they differ from the first charge. The
 * derived `methodLocked` (only `method` is payable, the picker is hidden) and `prolong`
 * (the page extends an existing subscription) stand in for `origin`, which is never
 * exposed; neither is `renewalOf`.
 */
export const CheckoutSessionPublic = CheckoutSession.pipe(
  Schema.pick(
    'amount',
    'currency',
    'period',
    'recurring',
    'status',
    'kind',
    'method',
    'successUrl',
    'failureUrl',
    'expiresAt',
    'renewal',
  ),
  Schema.extend(
    Schema.Struct({
      methodLocked: Schema.Boolean,
      prolong: Schema.Boolean,
    }),
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
