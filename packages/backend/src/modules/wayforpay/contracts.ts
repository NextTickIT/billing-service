import { Schema } from 'effect';

/**
 * WayForPay response shapes. Validation is permissive: a decode only validates the
 * boundary of the fields our logic reads and (with onExcessProperty: preserve)
 * keeps unknown keys, so one odd statement row never fails a whole window. Money
 * and date fields arrive as strings (sometimes numbers) — they are NOT coerced
 * here; `createdDate` feeds the event identity, so its exact form matters. Types
 * are DERIVED from the schemas so the decoded value and the static type never drift.
 */

export const REASON = {
  /** TRANSACTION_LIST / CHECK_STATUS: Ok. */
  OK: 1100,
  /** TRANSACTION_LIST: window exceeds the ~31-day cap. */
  WINDOW_TOO_LARGE: 1109,
  /** CHECK_STATUS: order not found. */
  ORDER_NOT_FOUND: 1127,
  /** regularApi STATUS: Ok. */
  REGULAR_OK: 4100,
  /** regularApi STATUS: subscription closed — still a valid state response. */
  REGULAR_CLOSED: 4107,
} as const;

/** String or number — money/date fields occur as both in the wild. */
const StringOrNumber = Schema.Union(Schema.String, Schema.Number);
const OptionalStringOrNumber = Schema.optional(StringOrNumber);
const NullableStringOrNumber = Schema.optional(Schema.NullOr(StringOrNumber));

/**
 * One TRANSACTION_LIST row: RAW shape as-is (values not coerced — external_id
 * depends on createdDate). Permissive: every field optional, money/dates allow a
 * number too, so one atypical row cannot fail the window's import.
 */
export const W4pTransactionSchema = Schema.Struct({
  transactionType: Schema.optional(Schema.String),
  orderReference: Schema.optional(Schema.String),
  createdDate: OptionalStringOrNumber,
  amount: OptionalStringOrNumber,
  currency: Schema.optional(Schema.String),
  baseAmount: OptionalStringOrNumber,
  baseCurrency: Schema.optional(Schema.String),
  transactionStatus: Schema.optional(Schema.String),
  processingDate: NullableStringOrNumber,
  settlementDate: NullableStringOrNumber,
  reasonCode: OptionalStringOrNumber,
  reason: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  phone: Schema.optional(Schema.String),
  paymentSystem: Schema.optional(Schema.NullOr(Schema.String)),
  cardPan: Schema.optional(Schema.String),
  cardType: Schema.optional(Schema.String),
  fee: OptionalStringOrNumber,
});

export type W4pTransaction = Schema.Schema.Type<typeof W4pTransactionSchema>;

export const W4pTransactionListResponseSchema = Schema.Struct({
  reasonCode: OptionalStringOrNumber,
  reason: Schema.optional(Schema.String),
  transactionList: Schema.optional(Schema.Array(W4pTransactionSchema)),
});

export const W4pCheckStatusResponseSchema = Schema.Struct({
  reasonCode: OptionalStringOrNumber,
  reason: Schema.optional(Schema.String),
  orderReference: Schema.optional(Schema.String),
  transactionStatus: Schema.optional(Schema.String),
  amount: OptionalStringOrNumber,
  currency: Schema.optional(Schema.String),
  refundAmount: OptionalStringOrNumber,
});

export type W4pCheckStatusResponse = Schema.Schema.Type<
  typeof W4pCheckStatusResponseSchema
>;

/**
 * regularApi STATUS response. reasonCode 4100 (Ok) or 4107 (closed) both carry
 * the subscription state fields (lastPayedDate/lastPayedStatus/nextPaymentDate).
 */
export const W4pRegularStatusResponseSchema = Schema.Struct({
  reasonCode: OptionalStringOrNumber,
  reason: Schema.optional(Schema.String),
  orderReference: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  lastPayedDate: NullableStringOrNumber,
  lastPayedStatus: Schema.optional(Schema.NullOr(Schema.String)),
  nextPaymentDate: NullableStringOrNumber,
});

export type W4pRegularStatusResponse = Schema.Schema.Type<
  typeof W4pRegularStatusResponseSchema
>;

/**
 * Natural external id of a transaction in the RAW layer. One orderReference can
 * yield several rows — a PURCHASE and its later REFUND share the ref but differ in
 * transactionType and createdDate — so the id is `ref|type|createdDate`: a REFUND
 * or a re-read never overwrites the original PURCHASE/CHARGE, each is its own row.
 */
export const transactionExternalId = (tx: W4pTransaction): string =>
  `${tx.orderReference ?? ''}|${tx.transactionType ?? ''}|${String(tx.createdDate ?? '')}`;
