import { Currency, currencyFromCode } from '@billing-service/shared';

import type { Charge, ChargeStatus } from '@/modules/charge/contracts.js';
import {
  transactionExternalId,
  type W4pTransaction,
} from '@/modules/wayforpay/contracts.js';

/**
 * Map WayForPay data to the normalized incoming-payment shape (docs/15). Pure, and
 * the field decisions (currency/status/amount) are shared by the poller and the
 * serviceUrl callback, so both normalize identically. Non-payment journal rows
 * (SETTLE, etc.) map to null and the poller skips-but-counts them.
 */

const PAYMENT_TYPES = new Set(['PURCHASE', 'CHARGE', 'REFUND']);

/** Amounts arrive as major-unit decimals ("10.10"); we store integer minor units. */
export const toMinorUnits = (amount: string | number | undefined): number => {
  const major = Number(amount);
  return Number.isFinite(major) ? Math.round(major * 100) : 0;
};

/** Epoch seconds (string or number) → Date; unparseable falls back to epoch 0. */
export const toDate = (value: string | number | undefined): Date => {
  const seconds = Number(value);
  return new Date(Number.isFinite(seconds) ? seconds * 1000 : 0);
};

/** Unknown currency defaults to UAH (settlement); the raw payload keeps the truth. */
export const toCurrency = (code: string | undefined): Currency =>
  currencyFromCode(code ?? '') ?? Currency.UAH;

/** Normalize a provider status; a REFUND operation is refunded regardless. */
export const w4pStatus = (
  transactionType: string | undefined,
  transactionStatus: string | undefined,
): ChargeStatus => {
  if (transactionType === 'REFUND') {
    return 'refunded';
  }
  switch (transactionStatus) {
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
 * Normalize a journal row, or null for a non-payment operation. `externalUserId`
 * is left null: legacy rows carry no reliable identity, so matching happens
 * downstream (orderReference-first, docs/15).
 */
export const mapTransaction = (tx: W4pTransaction): Charge | null => {
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
    currency: toCurrency(tx.currency),
    status: w4pStatus(tx.transactionType, tx.transactionStatus),
    occurredAt: toDate(tx.createdDate),
    payload: { ...tx },
  };
};
