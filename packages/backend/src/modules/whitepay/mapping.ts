import { Currency, currencyFromCode } from '@billing-service/shared';

import type { ChargeStatus } from '@/modules/charge/contracts.js';
import { WHITEPAY_STATUS } from '@/modules/whitepay/contracts.js';

/**
 * Map WhitePay order data to the normalized incoming-charge shape (docs/22). Pure, and
 * the field decisions (currency/status/amount) are shared by the create-order response
 * and the webhook so both normalize identically.
 */

/** WhitePay is FIAT-denominated in major units ("10.10"); we store integer minor units. */
export const toMinorUnits = (amount: string | number | undefined): number => {
  const major = Number(amount);
  return Number.isFinite(major) ? Math.round(major * 100) : 0;
};

/**
 * A timestamp → Date. WhitePay sends ISO-8601 strings (`completed_at`) but plugin
 * evidence also shows epoch seconds; try epoch-seconds first for a bare number, else
 * parse as a date string. Unparseable falls back to epoch 0 (never a crash).
 */
export const toDate = (value: string | number | undefined | null): Date => {
  if (typeof value === 'number') {
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }
  return new Date(0);
};

/** Unknown/absent currency defaults to UAH; the raw payload keeps the truth. */
export const toCurrency = (code: string | undefined): Currency =>
  currencyFromCode(code ?? '') ?? Currency.UAH;

/**
 * Normalize a WhitePay order status. `COMPLETE` succeeds; `DECLINED`/`CANCELED` fail;
 * everything else (`INIT`/`OPEN`, and `PARTIALLY_FULFILLED` — a crypto underpayment)
 * is `pending`, so it neither completes nor fails the checkout — it falls through to
 * quarantine (an operator alert), never to /dev/null (docs/22).
 */
export const whitePayStatus = (status: string | undefined): ChargeStatus => {
  switch (status) {
    case WHITEPAY_STATUS.COMPLETE:
      return 'succeeded';
    case WHITEPAY_STATUS.DECLINED:
    case WHITEPAY_STATUS.CANCELED:
      return 'failed';
    case WHITEPAY_STATUS.INIT:
    case WHITEPAY_STATUS.OPEN:
    case WHITEPAY_STATUS.PARTIALLY_FULFILLED:
      return 'pending';
    default:
      return 'unknown';
  }
};
