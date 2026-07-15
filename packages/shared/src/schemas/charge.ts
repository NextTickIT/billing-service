import { Schema } from 'effect';

import { CurrencySchema } from '@/schemas/payment.js';

/**
 * Normalized status of an incoming charge, provider-agnostic. Every source maps its
 * provider status into one of these before the event enters the pipeline (FR-007).
 */
export const CHARGE_STATUSES = [
  'succeeded',
  'failed',
  'refunded',
  'pending',
  'unknown',
] as const;

export const ChargeStatus = Schema.Literal(...CHARGE_STATUSES);

export type ChargeStatus = Schema.Schema.Type<typeof ChargeStatus>;

/**
 * GET /api/quarantine response item: an open quarantine row joined with its
 * incoming charge (the operator queue view). `quarantineId` is the
 * quarantine_records.id used in subsequent bind calls.
 */
export const QuarantineView = Schema.Struct({
  quarantineId: Schema.String,
  incomingEventId: Schema.String,
  source: Schema.String,
  externalRef: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
  occurredAt: Schema.Date,
  createdAt: Schema.Date,
});

export type QuarantineView = Schema.Schema.Type<typeof QuarantineView>;

/** POST /api/quarantine/:id/bind body: the operator supplies the target user. */
export const QuarantineBindRequest = Schema.Struct({
  externalUserId: Schema.String,
  subscriptionId: Schema.optional(Schema.String),
  period: Schema.optional(Schema.String),
  method: Schema.optional(Schema.Int),
});

export type QuarantineBindRequest = Schema.Schema.Type<
  typeof QuarantineBindRequest
>;

/** POST /api/quarantine/:id/bind response. */
export const BindAccepted = Schema.Struct({
  status: Schema.Literal('accepted'),
});

export type BindAccepted = Schema.Schema.Type<typeof BindAccepted>;
