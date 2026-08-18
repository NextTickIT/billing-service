import { Currency, PaymentMethod } from '@billing-service/shared';
import { describe, expect, it } from 'vitest';

import type { SpPayment } from '@/modules/legacy/contracts.js';
import {
  deriveMethod,
  mapPayment,
  spChargeStatus,
  toCurrency,
  toMinorUnits,
} from '@/modules/legacy/mapping.js';

const payment = (over: Partial<SpPayment> = {}): SpPayment => ({
  id: 2814758,
  contactId: 40810643,
  status: 200,
  price: { amount: 50, currency: 'USD' },
  paymentMethod: 'Wayforpay',
  createdAt: '2026-07-04T21:41:48.000000Z',
  orderId: '218fdd99-3ccd-45cc-b064-95b1c61fcd3f',
  ...over,
});

describe('toMinorUnits', () => {
  it('scales major units to integer minor units', () => {
    expect(toMinorUnits(50)).toBe(5000);
    expect(toMinorUnits('10.10')).toBe(1010);
  });
  it('is 0 for an unparseable amount', () => {
    expect(toMinorUnits(undefined)).toBe(0);
    expect(toMinorUnits('n/a')).toBe(0);
  });
});

describe('toCurrency', () => {
  it('parses an ISO code, defaulting unknown/absent to UAH', () => {
    expect(toCurrency('USD')).toBe(Currency.USD);
    expect(toCurrency('EUR')).toBe(Currency.EUR);
    expect(toCurrency('ZZZ')).toBe(Currency.UAH);
    expect(toCurrency(undefined)).toBe(Currency.UAH);
  });
});

describe('spChargeStatus', () => {
  it('maps SendPulse codes onto the charge vocabulary', () => {
    expect(spChargeStatus(200)).toBe('succeeded');
    expect(spChargeStatus(600)).toBe('succeeded');
    expect(spChargeStatus(300)).toBe('failed');
    expect(spChargeStatus(304)).toBe('failed');
    expect(spChargeStatus(500)).toBe('failed');
    expect(spChargeStatus(301)).toBe('refunded');
    expect(spChargeStatus(303)).toBe('refunded');
    expect(spChargeStatus(100)).toBe('pending');
    expect(spChargeStatus(999)).toBe('unknown');
    expect(spChargeStatus(undefined)).toBe('unknown');
  });
});

describe('deriveMethod', () => {
  it('is Crypto for Whitepay, Card otherwise', () => {
    expect(deriveMethod('Whitepay')).toBe(PaymentMethod.Crypto);
    expect(deriveMethod('Wayforpay')).toBe(PaymentMethod.Card);
    expect(deriveMethod('Telegram')).toBe(PaymentMethod.Card);
    expect(deriveMethod(undefined)).toBe(PaymentMethod.Card);
  });
});

describe('mapPayment', () => {
  it('maps a SendPulse payment to a normalized Charge', () => {
    const charge = mapPayment(payment());
    expect(charge).not.toBeNull();
    expect(charge?.source).toBe('sendpulse_legacy');
    expect(charge?.idemKey).toBe('sp:2814758');
    expect(charge?.externalUserId).toBe('sendpulse:40810643');
    expect(charge?.externalRef).toBe('218fdd99-3ccd-45cc-b064-95b1c61fcd3f');
    expect(charge?.amount).toBe(5000);
    expect(charge?.currency).toBe(Currency.USD);
    expect(charge?.status).toBe('succeeded');
    expect(charge?.occurredAt.toISOString()).toBe('2026-07-04T21:41:48.000Z');
  });

  it('preserves the raw payload verbatim', () => {
    const charge = mapPayment(payment({ dealName: 'Next Tick' }));
    expect(charge?.payload['dealName']).toBe('Next Tick');
  });

  it('drops a row without an id or contactId (unattributable)', () => {
    expect(mapPayment(payment({ id: undefined }))).toBeNull();
    expect(mapPayment(payment({ contactId: undefined }))).toBeNull();
  });
});
