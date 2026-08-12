import {
  CheckoutSessionKind,
  CheckoutSessionStatus,
} from '@billing-service/shared';
import { Redacted } from 'effect';
import { describe, expect, test } from 'vitest';

import { buildPurchase } from '@/modules/wayforpay/purchase.js';
import type { W4pConfigService } from '@/modules/wayforpay/config.js';

const config: W4pConfigService = {
  merchantAccount: 'm',
  merchantSecretKey: Redacted.make('sk'),
  merchantPassword: Redacted.make(''),
  apiUrl: '',
  regularApiUrl: '',
  merchantDomainName: 'shop.example',
  checkoutUrl: 'https://secure.wayforpay.com/pay',
  verifyUrl: 'https://secure.wayforpay.com/verify',
  serviceUrl: 'https://us/callback',
  returnUrl: 'https://us/return',
};

describe('buildPurchase', () => {
  const form = buildPurchase(
    config,
    {
      id: 'chk_1',
      externalUserId: 'sp:1',
      amount: 30000,
      currency: 0, // UAH
      period: 'P1M',
      method: 0,
      status: CheckoutSessionStatus.Pending,
      kind: CheckoutSessionKind.Checkout,
      paymentId: null,
      expiresAt: new Date(0),
      createdAt: new Date(0),
    },
    1700000000,
  );

  test('posts to the hosted checkout page with major-unit amount + code', () => {
    expect(form.action).toBe('https://secure.wayforpay.com/pay');
    expect(form.fields['orderReference']).toBe('chk_1');
    expect(form.fields['amount']).toBe(300);
    expect(form.fields['currency']).toBe('UAH');
    expect(form.fields['serviceUrl']).toBe('https://us/callback');
  });

  test('carries a signature and no regularMode (no WFP-managed schedule)', () => {
    expect(typeof form.fields['merchantSignature']).toBe('string');
    expect((form.fields['merchantSignature'] as string).length).toBe(32);
    expect(form.fields['regularMode']).toBeUndefined();
  });
});
