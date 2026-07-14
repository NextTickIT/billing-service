import { Schema } from 'effect';

/**
 * Normalized status of an incoming payment, provider-agnostic. Every source maps its
 * provider status into one of these before the event enters the pipeline (FR-007).
 */
export const PAYMENT_EVENT_STATUSES = [
  'succeeded',
  'failed',
  'refunded',
  'pending',
  'unknown',
] as const;

export const PaymentEventStatus = Schema.Literal(...PAYMENT_EVENT_STATUSES);

export type PaymentEventStatus = Schema.Schema.Type<typeof PaymentEventStatus>;
