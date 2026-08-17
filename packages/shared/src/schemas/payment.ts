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

/** Parse an ISO 4217 code back to the enum; undefined for an unknown currency. */
export const currencyFromCode = (code: string): Currency | undefined =>
  CurrencyByCode[code];

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
export const Payment = Schema.Struct({
  id: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int, // integer minimal currency units
  currency: CurrencySchema,
  method: PaymentMethodSchema,
  period: Schema.String,
  status: PaymentStatusSchema,
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
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export type Payment = Schema.Schema.Type<typeof Payment>;

/** Create params: the server owns `id`, the timestamps, and the cancel flag. */
export const CreatePayment = Payment.pipe(
  Schema.omit('id', 'createdAt', 'updatedAt', 'cancelRequestedAt'),
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

/** POST /api/payment body: operator creates a Payment directly. */
export const CreatePaymentRequest = Schema.Struct({
  externalUserId: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  period: Schema.String,
  method: Schema.optional(PaymentMethodSchema),
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

/** POST /api/payment/:id/defer response: the new paid-through date. */
export const DeferAccepted = Schema.Struct({
  status: Schema.Literal('deferred'),
  newPeriodEnd: Schema.Date,
});

export type DeferAccepted = Schema.Schema.Type<typeof DeferAccepted>;

/** POST /api/payment response: the new Payment id. */
export const CreateAccepted = Schema.Struct({ id: Schema.String });

export type CreateAccepted = Schema.Schema.Type<typeof CreateAccepted>;
