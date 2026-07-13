import { Currency } from '@billing-service/shared';
import { describe, expect, test } from 'vitest';

import { mapTransaction } from '@/modules/wayforpay/mapping.js';

describe('mapTransaction', () => {
  test('maps an approved PURCHASE to a succeeded event in minor units', () => {
    const event = mapTransaction({
      transactionType: 'PURCHASE',
      orderReference: 'o1',
      createdDate: '1700000000',
      amount: '10.10',
      currency: 'USD',
      transactionStatus: 'Approved',
    });
    expect(event).not.toBeNull();
    expect(event?.source).toBe('wayforpay_poller');
    expect(event?.idemKey).toBe('w4p:o1|PURCHASE|1700000000');
    expect(event?.amount).toBe(1010);
    expect(event?.currency).toBe(Currency.USD);
    expect(event?.status).toBe('succeeded');
    expect(event?.occurredAt.getTime()).toBe(1700000000 * 1000);
  });

  test('a REFUND row is a refunded event regardless of status', () => {
    expect(
      mapTransaction({
        transactionType: 'REFUND',
        orderReference: 'o1',
        createdDate: '1',
      })?.status,
    ).toBe('refunded');
  });

  test('a Declined charge is a failed event', () => {
    expect(
      mapTransaction({
        transactionType: 'CHARGE',
        transactionStatus: 'Declined',
        createdDate: '1',
      })?.status,
    ).toBe('failed');
  });

  test('a non-payment operation (SETTLE) is skipped', () => {
    expect(
      mapTransaction({ transactionType: 'SETTLE', createdDate: '1' }),
    ).toBeNull();
  });

  test('an unknown currency falls back to UAH (raw payload keeps the truth)', () => {
    const event = mapTransaction({
      transactionType: 'PURCHASE',
      currency: 'GBP',
      amount: '1',
      createdDate: '1',
    });
    expect(event?.currency).toBe(Currency.UAH);
    expect(event?.payload['currency']).toBe('GBP');
  });
});
