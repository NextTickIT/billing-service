import { Data, Schema } from 'effect';

/**
 * Legacy-import contracts (docs/25). The legacy source is SendPulse CRM payments
 * (`GET /crm/v1/payments/all`) — the only feed carrying the `contactId` that maps a
 * charge to our `externalUserId`. This module mirrors `wayforpay`: provider-shaped
 * parsing lives here, the pipeline stays processor-agnostic ([16](16-conventions.md) §12).
 */

/** `charges.source` for a legacy row; also the `legacy_sync_state` key. */
export const LEGACY_SOURCE = 'sendpulse_legacy';

/** `externalUserId` for a SendPulse contact — carried verbatim, never transformed. */
export const externalUserIdOf = (contactId: string): string =>
  `sendpulse:${contactId}`;

/** Charge dedup key from the SendPulse payment id (idempotent re-import). */
export const idemKeyOf = (paymentId: string): string => `sp:${paymentId}`;

/**
 * SendPulse payment status codes (analytics `statuses.ts`). `Paid`/`Manual` are the
 * only successful outcomes; the rest are non-paying terminal states. Numeric at the
 * source; coerced from string|number in mapping.
 */
export const SP_STATUS = {
  Created: 100,
  Paid: 200,
  Expired: 300,
  Refunded: 301,
  Voided: 303,
  ExpiredRare: 304,
  Declined: 500,
  Manual: 600,
} as const;

/**
 * Money and ids arrive as either string or number across SendPulse responses, so
 * every scalar is decoded permissively and coerced in `mapping.ts`; unknown extra
 * fields are preserved so the raw payload keeps the full truth ([25](25) §3.2).
 */
const StringOrNumber = Schema.Union(Schema.Number, Schema.String);

const SpPrice = Schema.Struct({
  amount: Schema.optional(StringOrNumber),
  currency: Schema.optional(Schema.String),
});

/**
 * One SendPulse CRM payment. Only `id` (→ idemKey) and `contactId` (→ externalUserId)
 * are load-bearing; a row missing either is unusable and dropped in mapping (tolerant
 * parsing, docs/16 §14). Everything else is optional so provider drift never fails the
 * whole import.
 */
export const SpPayment = Schema.Struct({
  id: Schema.optional(StringOrNumber),
  contactId: Schema.optional(StringOrNumber),
  dealId: Schema.optional(StringOrNumber),
  dealName: Schema.optional(Schema.String),
  status: Schema.optional(StringOrNumber),
  price: Schema.optional(SpPrice),
  paymentMethod: Schema.optional(Schema.String),
  merchantName: Schema.optional(Schema.String),
  orderId: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
});

export type SpPayment = Schema.Schema.Type<typeof SpPayment>;

/** `GET /crm/v1/payments/all` returns a root array or a `{ data: [...] }` envelope. */
export const SpPaymentsResponse = Schema.Union(
  Schema.Array(SpPayment),
  Schema.Struct({ data: Schema.Array(SpPayment) }),
);

export type SpPaymentsResponse = Schema.Schema.Type<typeof SpPaymentsResponse>;

export class SpTransportError extends Data.TaggedError('SpTransportError')<{
  readonly endpoint: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class SpResponseError extends Data.TaggedError('SpResponseError')<{
  readonly endpoint: string;
  readonly message: string;
}> {}

export type SpError = SpTransportError | SpResponseError;
