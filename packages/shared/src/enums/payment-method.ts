import { Schema } from 'effect';

/**
 * Enums/kinds are numeric TypeScript enums, stored as numbers everywhere
 * (db, backend, frontend). The Schema mirror validates the numeric values.
 */
export enum PaymentMethod {
  Card = 0,
  Crypto = 1,
}

export const PaymentMethodSchema = Schema.Enums(PaymentMethod);
