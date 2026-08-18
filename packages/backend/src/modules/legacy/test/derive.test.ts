import { Currency, PaymentStatus } from '@billing-service/shared';
import { expect, it } from 'vitest';

import type { Charge, ChargeStatus } from '@/modules/charge/contracts.js';
import {
  deriveExternalPayment,
  resolveExternalStatus,
} from '@/modules/legacy/derive.js';

const charge = (
  status: ChargeStatus,
  occurredAt: string,
  over: Partial<Charge> = {},
): Charge => ({
  source: 'sendpulse_legacy',
  idemKey: `sp:${occurredAt}`,
  externalRef: '',
  externalUserId: 'sendpulse:1',
  amount: 5000,
  currency: Currency.USD,
  status,
  occurredAt: new Date(occurredAt),
  payload: {},
  ...over,
});

const NOW = new Date('2026-08-01T00:00:00Z');

it('derive: a single recent success is Active, default P1M, anchored at the charge', () => {
  const d = deriveExternalPayment(
    [charge('succeeded', '2026-07-15T00:00:00Z')],
    NOW,
  );
  expect(d.status).toBe(PaymentStatus.Active);
  expect(d.period).toBe('P1M');
  expect(d.currentPeriodStart.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  expect(d.currentPeriodEnd.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  expect(d.nextPaymentDate.toISOString()).toBe('2026-08-15T00:00:00.000Z');
});

it('derive: infers a monthly cadence from ~30-day gaps', () => {
  const d = deriveExternalPayment(
    [
      charge('succeeded', '2026-06-15T00:00:00Z'),
      charge('succeeded', '2026-07-15T00:00:00Z'),
    ],
    NOW,
  );
  expect(d.period).toBe('P1M');
  expect(d.status).toBe(PaymentStatus.Active);
});

it('derive: infers a yearly cadence from ~365-day gaps', () => {
  const d = deriveExternalPayment(
    [
      charge('succeeded', '2025-07-15T00:00:00Z'),
      charge('succeeded', '2026-07-15T00:00:00Z'),
    ],
    NOW,
  );
  expect(d.period).toBe('P1Y');
});

it('derive: takes money from the latest succeeded charge', () => {
  const d = deriveExternalPayment(
    [
      charge('succeeded', '2026-06-15T00:00:00Z', {
        amount: 3000,
        currency: Currency.UAH,
      }),
      charge('succeeded', '2026-07-15T00:00:00Z', {
        amount: 9900,
        currency: Currency.USD,
      }),
    ],
    NOW,
  );
  expect(d.amount).toBe(9900);
  expect(d.currency).toBe(Currency.USD);
});

it('derive: a refunded/voided last event is Cancelled', () => {
  const d = deriveExternalPayment(
    [
      charge('succeeded', '2026-06-15T00:00:00Z'),
      charge('refunded', '2026-07-15T00:00:00Z'),
    ],
    NOW,
  );
  expect(d.status).toBe(PaymentStatus.Cancelled);
});

it('derive: never paid (only failures) is a lapsed RenewalFailed', () => {
  const d = deriveExternalPayment(
    [charge('failed', '2026-07-15T00:00:00Z')],
    NOW,
  );
  expect(d.status).toBe(PaymentStatus.RenewalFailed);
});

it('derive: a paid-but-lapsed period is RenewalFailed', () => {
  const d = deriveExternalPayment(
    [charge('succeeded', '2026-01-15T00:00:00Z')],
    NOW,
  );
  expect(d.status).toBe(PaymentStatus.RenewalFailed);
});

it('resolveExternalStatus downgrades Active to Cancelled on a conflict', () => {
  expect(resolveExternalStatus(PaymentStatus.Active, true)).toBe(
    PaymentStatus.Cancelled,
  );
});

it('resolveExternalStatus keeps the derived status otherwise', () => {
  expect(resolveExternalStatus(PaymentStatus.Active, false)).toBe(
    PaymentStatus.Active,
  );
  expect(resolveExternalStatus(PaymentStatus.RenewalFailed, true)).toBe(
    PaymentStatus.RenewalFailed,
  );
});
