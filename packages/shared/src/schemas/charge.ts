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
 * What STARTED a successful charge, reported on every success event (owner decision
 * 2026-10-21): `scheduled` — billing's own renewal charge of the stored token (the
 * scheduler's `sub_…` order, or a WayForPay-managed regular payment of the migration
 * tail); `checkout` — a payment through a checkout session (a first payment, a plain
 * checkout, a manual-renewal link, a card change). It is the origin, never the path that
 * settled it: a scheduled charge stays `scheduled` whether the scheduler's own call, the
 * provider callback or the poller brought it in.
 */
export const CHARGE_KINDS = ['scheduled', 'checkout'] as const;

export const ChargeKind = Schema.Literal(...CHARGE_KINDS);

export type ChargeKind = Schema.Schema.Type<typeof ChargeKind>;

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
