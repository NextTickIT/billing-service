import { Schema } from 'effect';

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
