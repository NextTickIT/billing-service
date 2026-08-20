import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Charge } from '@/modules/charge/contracts.js';
import {
  toCurrency,
  toDate,
  toMinorUnits,
  whitePayStatus,
} from '@/modules/whitepay/mapping.js';

/**
 * WhitePay webhook processing (docs/17/22). The webhook is verified against an
 * HMAC-SHA256 of the RAW body keyed with the per-page Webhook Token (re-serializing
 * the JSON is a real signature-mismatch trap — always the raw bytes), normalized into
 * the standard incoming `Charge` so it flows through the same pipeline as every other
 * source (FR-007), and acknowledged with HTTP 200. The `X-Secret-Key` shared-secret
 * header is accepted defensively (some integrations send it instead of `Signature`).
 */

/** Constant-time equality that never throws on unequal lengths or non-hex input. */
const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export const hmacSha256Hex = (raw: string, key: string): string =>
  createHmac('sha256', key).update(raw, 'utf8').digest('hex');

/**
 * Verify a webhook. Valid when the `Signature` header equals HMAC-SHA256(rawBody,
 * webhookToken), OR the `X-Secret-Key` header equals the webhook token (shared-secret
 * mode). An empty token (unconfigured) never verifies — a dark deploy rejects callbacks.
 */
export const verifyWebhook = (
  webhookToken: string,
  rawBody: string,
  signature: string | undefined,
  secretKey: string | undefined,
): boolean => {
  const token = webhookToken;
  if (token.length === 0) {
    return false;
  }
  if (signature !== undefined && signature.length > 0) {
    return safeEqual(hmacSha256Hex(rawBody, token), signature);
  }
  if (secretKey !== undefined && secretKey.length > 0) {
    return safeEqual(secretKey, token);
  }
  return false;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** The order object, whether the webhook wraps it under `order` or sends it flat. */
const orderOf = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) {
    return {};
  }
  const nested = payload['order'];
  return isRecord(nested) ? nested : payload;
};

/** Read an order field as a string without stringifying nested objects. */
const str = (order: Record<string, unknown>, key: string): string => {
  const value = order[key];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : '';
};

const numOrStr = (
  order: Record<string, unknown>,
  key: string,
): string | number | undefined => {
  const value = order[key];
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
};

/**
 * Normalize a webhook into an incoming `Charge`. The idempotency key is the order id
 * plus the status, so an at-least-once redelivery of the same transition dedupes while
 * a later status change is its own event (mirrors the WayForPay callback, docs/22).
 * `externalRef` is our checkout session id (`external_order_id`), the match key.
 */
export const normalizeWebhook = (payload: unknown): Charge => {
  const order = orderOf(payload);
  const status = str(order, 'status');
  const completedAt = numOrStr(order, 'completed_at');
  return {
    source: 'whitepay_callback',
    idemKey: `wp:${str(order, 'id')}|${status}`,
    externalRef: str(order, 'external_order_id'),
    externalUserId: null,
    amount: toMinorUnits(numOrStr(order, 'value')),
    currency: toCurrency(str(order, 'currency') || undefined),
    status: whitePayStatus(status || undefined),
    occurredAt: toDate(completedAt ?? numOrStr(order, 'created_at')),
    payload: isRecord(payload) ? payload : {},
  };
};
