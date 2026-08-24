import { Schema } from 'effect';

/**
 * WhitePay response shapes (docs/26). Validation is permissive: only the fields our
 * logic reads are bounded and, with `onExcessProperty: preserve`, unknown keys survive,
 * so an extra provider field never drops an order. Money/date fields arrive as string OR
 * number and are NOT coerced here (see mapping.ts). Types are DERIVED from the schemas.
 */

/** String or number — WhitePay money/rate fields occur as both in plugin evidence. */
const StringOrNumber = Schema.Union(Schema.String, Schema.Number);
/**
 * `Schema.optional` alone rejects a field that is PRESENT with value `null`, but the
 * live create-order response returns `null` for not-yet-known fields (e.g.
 * `expected_amount`, `deposited_currency` before the payer deposits). `nullable: true`
 * tolerates absent AND present-null, decoding both to `undefined`, so the mapping layer
 * keeps seeing `string | number | undefined` with no null widening downstream (docs/26).
 */
const OptionalStringOrNumber = Schema.optionalWith(StringOrNumber, {
  nullable: true,
});
const OptionalString = Schema.optionalWith(Schema.String, { nullable: true });

/**
 * A crypto order. `external_order_id` is our checkout session id (the match key);
 * `acquiring_url` is the hosted checkout link; `value` is the fiat-denominated invoice
 * amount; `received_total` is what actually arrived (matters for PARTIALLY_FULFILLED).
 * No token/mandate/recToken field exists anywhere — the make-or-break finding (docs/26).
 */
export const WhitePayOrderSchema = Schema.Struct({
  id: OptionalString,
  status: OptionalString,
  external_order_id: OptionalString,
  acquiring_url: OptionalString,
  currency: OptionalString,
  value: OptionalStringOrNumber,
  expected_amount: OptionalStringOrNumber,
  received_total: OptionalStringOrNumber,
  deposited_currency: OptionalString,
  received_currency: OptionalString,
  order_number: OptionalStringOrNumber,
  created_at: OptionalStringOrNumber,
  completed_at: OptionalStringOrNumber,
});

export type WhitePayOrder = Schema.Schema.Type<typeof WhitePayOrderSchema>;

/**
 * Create-order and webhook bodies both wrap the order under `order`; some plugin
 * evidence returns the order flat. `extractOrder` (client/callback) tolerates both.
 */
export const OrderEnvelopeSchema = Schema.Struct({
  order: Schema.optionalWith(WhitePayOrderSchema, { nullable: true }),
});

/** Order lifecycle statuses (docs/26). `PARTIALLY_FULFILLED` = crypto underpayment. */
export const WHITEPAY_STATUS = {
  INIT: 'INIT',
  OPEN: 'OPEN',
  COMPLETE: 'COMPLETE',
  DECLINED: 'DECLINED',
  PARTIALLY_FULFILLED: 'PARTIALLY_FULFILLED',
  CANCELED: 'CANCELED',
} as const;
