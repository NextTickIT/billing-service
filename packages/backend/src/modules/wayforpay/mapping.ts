import { Currency } from '@billing-service/shared';

import type {
  IncomingPaymentEvent,
  PaymentEventStatus,
} from '@/modules/payments/contracts.js';
import {
  transactionExternalId,
  type W4pTransaction,
} from '@/modules/wayforpay/contracts.js';

/**
 * Map a WayForPay journal row to a normalized incoming payment (docs/15). Pure, so
 * the field decisions are unit-tested without a client or DB. Non-payment rows
 * (SETTLE, etc.) map to null and are skipped-but-counted by the poller — only the
 * payment operations become events.
 */

const PAYMENT_TYPES = new Set(['PURCHASE', 'CHARGE', 'REFUND']);

const CURRENCY_BY_CODE: Readonly<Record<string, Currency>> = {
  UAH: Currency.UAH,
  USD: Currency.USD,
  EUR: Currency.EUR,
};

/** Amounts arrive as major-unit decimals ("10.10"); we store integer minor units. */
const toMinorUnits = (amount: string | number | undefined): number => {
  const major = Number(amount);
  return Number.isFinite(major) ? Math.round(major * 100) : 0;
};

/** Epoch seconds (string or number) → Date; unparseable falls back to epoch 0. */
const toDate = (createdDate: string | number | undefined): Date => {
  const seconds = Number(createdDate);
  return new Date(Number.isFinite(seconds) ? seconds * 1000 : 0);
};

const toStatus = (tx: W4pTransaction): PaymentEventStatus => {
  if (tx.transactionType === 'REFUND') {
    return 'refunded';
  }
  switch (tx.transactionStatus) {
    case 'Approved':
      return 'succeeded';
    case 'Declined':
    case 'Expired':
      return 'failed';
    case 'Refunded':
      return 'refunded';
    case 'InProcessing':
    case 'Pending':
    case 'WaitingAuthComplete':
      return 'pending';
    default:
      return 'unknown';
  }
};

/**
 * Normalize a payment row, or null for a non-payment operation. Unknown currency
 * defaults to UAH (the settlement currency) — the raw payload keeps the true value
 * for reconciliation. `externalUserId` is left null: legacy rows carry no reliable
 * identity, so matching happens downstream (orderReference-first, docs/15).
 */
export const mapTransaction = (
  tx: W4pTransaction,
): IncomingPaymentEvent | null => {
  if (
    tx.transactionType === undefined ||
    !PAYMENT_TYPES.has(tx.transactionType)
  ) {
    return null;
  }
  return {
    source: 'wayforpay_poller',
    idemKey: `w4p:${transactionExternalId(tx)}`,
    externalRef: tx.orderReference ?? '',
    externalUserId: null,
    amount: toMinorUnits(tx.amount),
    currency: CURRENCY_BY_CODE[tx.currency ?? ''] ?? Currency.UAH,
    status: toStatus(tx),
    occurredAt: toDate(tx.createdDate),
    payload: { ...tx },
  };
};
