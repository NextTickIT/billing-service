import {
  Currency,
  currencyFromCode,
  PaymentMethod,
} from '@billing-service/shared';

import type { Charge, ChargeStatus } from '@/modules/charge/contracts.js';
import {
  externalUserIdOf,
  idemKeyOf,
  LEGACY_SOURCE,
  SP_STATUS,
  type SpPayment,
} from '@/modules/legacy/contracts.js';

/**
 * Map a SendPulse CRM payment to the normalized `Charge` (docs/25 §3.2). Pure: the
 * import stores each mapped charge raw and fixes it to the user's external Payment. A
 * row missing its `id` or `contactId` cannot be attributed, so it maps to null and the
 * import drops-but-counts it (tolerant parsing, docs/16 §14).
 */

/** SendPulse amounts are major-unit numbers ("50"); we store integer minor units. */
export const toMinorUnits = (amount: string | number | undefined): number => {
  const major = Number(amount);
  return Number.isFinite(major) ? Math.round(major * 100) : 0;
};

/** Unknown currency defaults to UAH; the raw payload keeps the truth (docs/25 §3.2). */
export const toCurrency = (code: string | undefined): Currency =>
  currencyFromCode(code ?? '') ?? Currency.UAH;

/** ISO-8601 `createdAt` → Date; an unparseable value falls back to epoch 0. */
export const toDate = (value: string | undefined): Date => {
  const ms = value === undefined ? NaN : Date.parse(value);
  return new Date(Number.isNaN(ms) ? 0 : ms);
};

/**
 * Collapse a SendPulse status code onto the provider-agnostic charge vocabulary.
 * `Paid`/`Manual` are the only successful outcomes; `Refunded`/`Voided` returned
 * money; `Expired`/`Declined` never paid; `Created` is an opened-but-unpaid checkout.
 */
export const spChargeStatus = (
  code: string | number | undefined,
): ChargeStatus => {
  switch (Number(code)) {
    case SP_STATUS.Paid:
    case SP_STATUS.Manual:
      return 'succeeded';
    case SP_STATUS.Refunded:
    case SP_STATUS.Voided:
      return 'refunded';
    case SP_STATUS.Expired:
    case SP_STATUS.ExpiredRare:
    case SP_STATUS.Declined:
      return 'failed';
    case SP_STATUS.Created:
      return 'pending';
    default:
      return 'unknown';
  }
};

/** SendPulse crypto payments (Whitepay) map to `Crypto`; everything else is `Card`. */
export const deriveMethod = (
  paymentMethod: string | undefined,
): PaymentMethod =>
  (paymentMethod ?? '').toLowerCase() === 'whitepay'
    ? PaymentMethod.Crypto
    : PaymentMethod.Card;

export const mapPayment = (sp: SpPayment): Charge | null => {
  if (sp.id === undefined || sp.contactId === undefined) {
    return null;
  }
  return {
    source: LEGACY_SOURCE,
    idemKey: idemKeyOf(String(sp.id)),
    externalRef: sp.orderId ?? '',
    externalUserId: externalUserIdOf(String(sp.contactId)),
    amount: toMinorUnits(sp.price?.amount),
    currency: toCurrency(sp.price?.currency),
    status: spChargeStatus(sp.status),
    occurredAt: toDate(sp.createdAt),
    payload: { ...sp },
  };
};
