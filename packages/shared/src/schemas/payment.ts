import { Schema } from 'effect';

/**
 * Payment methods are numeric enums stored as numbers everywhere; the Schema
 * mirror validates the values. Owned by the payment slice.
 */
export enum PaymentMethod {
  Card = 0,
  Crypto = 1,
}

export const PaymentMethodSchema = Schema.Enums(PaymentMethod);

/**
 * Currency is a closed set stored as a number, not a free string, so only
 * allowed values can ever be persisted. `CurrencyCode` maps each to its ISO 4217
 * string for human-readable rendering at the edges.
 */
export enum Currency {
  UAH = 0,
  USD = 1,
  EUR = 2,
}

export const CurrencySchema = Schema.Enums(Currency);

export const CurrencyCode: Readonly<Record<Currency, string>> = {
  [Currency.UAH]: 'UAH',
  [Currency.USD]: 'USD',
  [Currency.EUR]: 'EUR',
};

const CurrencyByCode: Readonly<Record<string, Currency>> = {
  UAH: Currency.UAH,
  USD: Currency.USD,
  EUR: Currency.EUR,
};

/** Parse an ISO 4217 code back to the enum; undefined for an unknown currency. Case-
 * and whitespace-insensitive so a provider echoing `usd`/` USD ` isn't misread (which,
 * via the `toCurrency` default, would otherwise silently book the charge as UAH). */
export const currencyFromCode = (code: string): Currency | undefined =>
  CurrencyByCode[code.trim().toUpperCase()];

/**
 * Payment lifecycle (docs/05). `active` when paid; `past_due` inside the
 * retry window (days 0–7); `renewal_failed` after the final retry (the gateway
 * then stops); `cancelled` by operator or provider. Stored as a number.
 */
export enum PaymentStatus {
  Active = 0,
  PastDue = 1,
  RenewalFailed = 2,
  Cancelled = 3,
}

export const PaymentStatusSchema = Schema.Enums(PaymentStatus);

/**
 * Single source of truth for the Payment contract. The static type is
 * DERIVED from this schema; the same shape is used at db, backend, and frontend
 * with no transformation. `period` is an ISO-8601 duration (e.g. `P1M`);
 * `recurringTokenRef` points at the stored provider token (null for crypto or
 * before tokenization); `firstFailureAt`/`retryAttempt` drive the FR-005 retries.
 */
/**
 * Caller-supplied passthrough. Billing never reads, validates or branches on it: the
 * external system declares what a purchase MEANS to it (a plan code, a campaign, a chosen
 * duration) and we hand that back on every event the purchase produces, so a consumer
 * does not have to re-derive intent from an amount.
 *
 * Opaque by design — `Schema.Unknown` values, so a shape change upstream never fails a
 * decode here, and no billing logic can start depending on a key.
 */
export const Metadata = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

export type Metadata = Schema.Schema.Type<typeof Metadata>;

export const Payment = Schema.Struct({
  id: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int, // integer minimal currency units
  currency: CurrencySchema,
  method: PaymentMethodSchema,
  period: Schema.String,
  status: PaymentStatusSchema,
  // false for a one-time payment: created fresh per charge (never extended), holds no
  // reusable token, excluded from the scheduler and the one-active-per-user rule, so a
  // user may have any number alongside a single recurring payment. Default true.
  recurring: Schema.Boolean,
  currentPeriodStart: Schema.Date,
  currentPeriodEnd: Schema.Date,
  nextPaymentDate: Schema.Date,
  recurringTokenRef: Schema.NullOr(Schema.String),
  firstFailureAt: Schema.NullOr(Schema.Date),
  retryAttempt: Schema.Int,
  // Set when an operator soft-cancels: the payment stays `active` (access runs to
  // currentPeriodEnd) and the scheduler lapses it at the due date instead of
  // charging. Null in normal operation. See docs/23.
  cancelRequestedAt: Schema.NullOr(Schema.Date),
  // The most recently DECLARED purchase intent, carried onto every event this payment
  // emits. Re-stamped whenever a checkout supplies one (create or extend), so a renewal
  // reports what the buyer last chose rather than a stale first purchase; a checkout that
  // supplies none leaves it untouched. Null when no checkout ever supplied one.
  metadata: Schema.NullOr(Metadata),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export type Payment = Schema.Schema.Type<typeof Payment>;

/** Create params: the server owns `id`, the timestamps, and the cancel flag. `metadata` is
 * optional here — most payments are born without a declaration, and the column stores
 * NULL for them; only a checkout that carried one passes it. */
/**
 * How a checkout takes its first money. `now`: the first period is charged at checkout, as
 * always. `card_check`: the checkout only verifies the card and keeps its token; the first
 * plan-price charge is the ordinary scheduled one at `startsAt` (a payer migrating in who
 * is already paid elsewhere until then). Stored on the session and on the payment it
 * creates; `now` on every row from before the column existed.
 */
export const FIRST_CHARGES = ['now', 'card_check'] as const;

export const FirstCharge = Schema.Literal(...FIRST_CHARGES);

export type FirstCharge = Schema.Schema.Type<typeof FirstCharge>;

export const CreatePayment = Payment.pipe(
  Schema.omit('id', 'createdAt', 'updatedAt', 'cancelRequestedAt', 'metadata'),
  // Optional AND nullable: callers express "none declared" either by omitting the field
  // or by passing null, and both store NULL. `firstCharge` absent stores `now`.
  Schema.extend(
    Schema.Struct({
      metadata: Schema.optional(Schema.NullOr(Metadata)),
      firstCharge: Schema.optional(FirstCharge),
    }),
  ),
);

export type CreatePayment = Schema.Schema.Type<typeof CreatePayment>;

/**
 * Fixed retry schedule (days from the first failed recurring charge) — the
 * payment's recurring-charge retry policy. See FR-005 in
 * docs/02-functional-requirements.md.
 */
export const RETRY_SCHEDULE_DAYS = [0, 1, 3, 5, 7] as const;

/**
 * A completed charge fixation — a successful incoming payment event that has
 * been matched and recorded against a Payment. `source` is the provider-agnostic
 * label (e.g. 'wayforpay'); `occurredAt` is when the charge occurred at the provider.
 */
export const ChargeFixation = Schema.Struct({
  id: Schema.String,
  incomingEventId: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  source: Schema.String,
  occurredAt: Schema.Date,
});

export type ChargeFixation = Schema.Schema.Type<typeof ChargeFixation>;

/** GET /api/payment/:id response: the Payment plus its charge history. */
export const PaymentDetail = Schema.Struct({
  ...Payment.fields,
  charges: Schema.Array(ChargeFixation),
});

export type PaymentDetail = Schema.Schema.Type<typeof PaymentDetail>;

/** POST /api/payment body: operator creates a Payment directly. `recurring` defaults
 * to true (a subscription); pass false to record a one-time payment. */
export const CreatePaymentRequest = Schema.Struct({
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  period: Schema.String,
  method: Schema.optional(PaymentMethodSchema),
  recurring: Schema.optional(Schema.Boolean),
});

export type CreatePaymentRequest = Schema.Schema.Type<
  typeof CreatePaymentRequest
>;

/** POST /api/payment/:id/cancel body: operator cancels a Payment. */
export const CancelPaymentRequest = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export type CancelPaymentRequest = Schema.Schema.Type<
  typeof CancelPaymentRequest
>;

/** POST /api/payment/:id/cancel response. */
export const CancelAccepted = Schema.Struct({
  status: Schema.Literal('cancelled'),
});

export type CancelAccepted = Schema.Schema.Type<typeof CancelAccepted>;

/** POST /api/payment/:id/reactivate response (un-cancel within the grace window). */
export const ReactivateAccepted = Schema.Struct({
  status: Schema.Literal('active'),
});

export type ReactivateAccepted = Schema.Schema.Type<typeof ReactivateAccepted>;

/**
 * POST /api/payment/:id/defer body: grant N free days (docs/23). Bounds are
 * enforced in the domain (1..30) with a typed error, not by the schema, so the
 * route returns a 422 with a reason rather than a generic decode 400.
 */
export const DeferPaymentRequest = Schema.Struct({
  days: Schema.Int,
});

export type DeferPaymentRequest = Schema.Schema.Type<
  typeof DeferPaymentRequest
>;

/**
 * The handover defer (service token): move the first charge of a card-check payment that
 * has taken no money yet to the absolute instant `deferTo`. Forward only and bounded; it
 * grants no access (the payer is still paid elsewhere until then).
 */
export const HandoverDeferRequest = Schema.Struct({
  reason: Schema.Literal('handover'),
  deferTo: Schema.Date,
});

export type HandoverDeferRequest = Schema.Schema.Type<
  typeof HandoverDeferRequest
>;

/**
 * POST /api/payment/:id/defer body as the route decodes it: an operator defer (`days`) or
 * a handover defer (`reason` + `deferTo`). Loose on purpose: which fields may appear
 * together is the route's rule (a 422), so a mixed body cannot fall through to the other
 * branch by having its extra key dropped.
 */
export const DeferRequest = Schema.Struct({
  days: Schema.optional(Schema.Int),
  reason: Schema.optional(Schema.Literal('handover')),
  deferTo: Schema.optional(Schema.Date),
});

export type DeferRequest = Schema.Schema.Type<typeof DeferRequest>;

/**
 * POST /api/payment/:id/defer response. `revision` is the payment's defer revision after
 * the call: every applied defer increments it in the same UPDATE that moves the date, so
 * it orders defers where the queue cannot. `unchanged`: a handover defer to a date not
 * after the current one wrote nothing. `revision` is optional only so a ledger row stored
 * before it existed still replays.
 */
export const DeferAccepted = Schema.Struct({
  status: Schema.Literal('deferred', 'unchanged'),
  newPeriodEnd: Schema.Date,
  revision: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
});

export type DeferAccepted = Schema.Schema.Type<typeof DeferAccepted>;

/** POST /api/payment response: the new Payment id. */
export const CreateAccepted = Schema.Struct({ id: Schema.String });

export type CreateAccepted = Schema.Schema.Type<typeof CreateAccepted>;

/**
 * POST /api/payment/apply-offer body: the CRM hands over a campaign buyer. `buyerId` is
 * the id the paid campaign checkout ran under; `externalUserId` is the contact the
 * purchase belongs to from now on.
 */
export const ApplyOfferRequest = Schema.Struct({
  buyerId: Schema.NonEmptyString,
  externalUserId: Schema.NonEmptyString,
});

export type ApplyOfferRequest = Schema.Schema.Type<typeof ApplyOfferRequest>;

/**
 * POST /api/payment/apply-offer response: the contact's live subscription — the member's,
 * which the purchase `extended`, or the purchase's own, moved to a new buyer (`created`) —
 * and its paid-through end and next charge date, the latter also as DD.MM.YYYY (Kyiv) for
 * the bot to drop into a message.
 */
export const ApplyOfferAccepted = Schema.Struct({
  result: Schema.Literal('extended', 'created'),
  paymentId: Schema.String,
  periodEnd: Schema.Date,
  nextPaymentDate: Schema.Date,
  nextPaymentDate_formatted: Schema.String,
});

export type ApplyOfferAccepted = Schema.Schema.Type<typeof ApplyOfferAccepted>;
