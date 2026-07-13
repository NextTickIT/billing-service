import { Schema } from 'effect';

/**
 * Payment methods are numeric enums stored as numbers everywhere; the Schema
 * mirror validates the values. Owned by the subscription slice.
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

/**
 * Single source of truth for the Subscription contract. The static type is
 * DERIVED from this schema; the same shape is used at db, backend, and frontend
 * with no transformation.
 */
export const Subscription = Schema.Struct({
  id: Schema.String,
  externalUserId: Schema.String,
  amount: Schema.Int, // integer minimal currency units
  currency: CurrencySchema,
  method: PaymentMethodSchema,
});

export type Subscription = Schema.Schema.Type<typeof Subscription>;

/** Create params = the entity without its server-owned `id`. */
export const CreateSubscription = Subscription.pipe(Schema.omit('id'));

export type CreateSubscription = Schema.Schema.Type<typeof CreateSubscription>;

/**
 * Fixed retry schedule (days from the first failed recurring charge) — the
 * subscription's recurring-charge retry policy. See FR-005 in
 * docs/02-functional-requirements.md.
 */
export const RETRY_SCHEDULE_DAYS = [0, 1, 3, 5, 7] as const;
