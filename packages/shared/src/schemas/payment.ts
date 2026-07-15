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
  nextChargeDate: Schema.Date,
  recurringTokenRef: Schema.NullOr(Schema.String),
  firstFailureAt: Schema.NullOr(Schema.Date),
  retryAttempt: Schema.Int,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

export type Payment = Schema.Schema.Type<typeof Payment>;

/** Create params: the server owns `id` and the timestamps. */
export const CreatePayment = Payment.pipe(
  Schema.omit('id', 'createdAt', 'updatedAt'),
);

export type CreatePayment = Schema.Schema.Type<typeof CreatePayment>;

/**
 * Fixed retry schedule (days from the first failed recurring charge) — the
 * payment's recurring-charge retry policy. See FR-005 in
 * docs/02-functional-requirements.md.
 */
export const RETRY_SCHEDULE_DAYS = [0, 1, 3, 5, 7] as const;
