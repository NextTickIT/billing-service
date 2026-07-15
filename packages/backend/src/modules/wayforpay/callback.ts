import { Redacted } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import {
  toCurrency,
  toDate,
  toMinorUnits,
  w4pStatus,
} from '@/modules/wayforpay/mapping.js';
import {
  ackSignatureBase,
  callbackSignatureBase,
  hmacMd5Hex,
} from '@/modules/wayforpay/signature.js';

/**
 * WayForPay serviceUrl callback processing (docs/14). The callback is verified
 * against the 8-field HMAC, normalized into a standard incoming event (so it flows
 * through the same pipeline as every other source, FR-007), and acknowledged with
 * the required signed `accept` (WayForPay retries for 4 days until it gets one).
 */
export type CallbackPayload = Record<string, unknown>;

/** Read a callback field as a string without stringifying objects. */
const field = (payload: CallbackPayload, key: string): string => {
  const value = payload[key];
  if (typeof value === 'string') {
    return value;
  }
  return typeof value === 'number' ? String(value) : '';
};

export const verifyCallback = (
  config: W4pConfigService,
  payload: CallbackPayload,
): boolean => {
  const expected = hmacMd5Hex(
    callbackSignatureBase({
      merchantAccount: field(payload, 'merchantAccount'),
      orderReference: field(payload, 'orderReference'),
      amount: field(payload, 'amount'),
      currency: field(payload, 'currency'),
      authCode: field(payload, 'authCode'),
      cardPan: field(payload, 'cardPan'),
      transactionStatus: field(payload, 'transactionStatus'),
      reasonCode: field(payload, 'reasonCode'),
    }),
    Redacted.value(config.merchantSecretKey),
  );
  return expected === field(payload, 'merchantSignature');
};

/**
 * Normalize a callback into an incoming event. The idempotency key is the order
 * plus the status, so at-least-once retries of the same transition dedupe while a
 * later status change (e.g. a refund) is its own event.
 */
export const normalizeCallback = (
  payload: CallbackPayload,
): Charge => {
  const orderReference = field(payload, 'orderReference');
  const transactionStatus = field(payload, 'transactionStatus');
  return {
    source: 'wayforpay_callback',
    idemKey: `w4pcb:${orderReference}|${transactionStatus}`,
    externalRef: orderReference,
    externalUserId: null,
    amount: toMinorUnits(field(payload, 'amount')),
    currency: toCurrency(field(payload, 'currency')),
    status: w4pStatus(field(payload, 'transactionType'), transactionStatus),
    occurredAt: toDate(
      field(payload, 'createdDate') || field(payload, 'processingDate'),
    ),
    payload,
  };
};

export interface CallbackAck {
  readonly orderReference: string;
  readonly status: 'accept';
  readonly time: number;
  readonly signature: string;
}

export const ackResponse = (
  config: W4pConfigService,
  orderReference: string,
  timeSeconds: number,
): CallbackAck => ({
  orderReference,
  status: 'accept',
  time: timeSeconds,
  signature: hmacMd5Hex(
    ackSignatureBase(orderReference, 'accept', timeSeconds),
    Redacted.value(config.merchantSecretKey),
  ),
});
