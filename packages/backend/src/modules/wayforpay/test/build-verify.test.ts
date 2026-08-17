import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
} from '@billing-service/shared';
import { Redacted } from 'effect';
import { describe, expect, test } from 'vitest';

import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import { buildVerify } from '@/modules/wayforpay/purchase.js';
import { signVerify } from '@/modules/wayforpay/signature.js';

const config: W4pConfigService = {
  merchantAccount: 'm',
  merchantSecretKey: Redacted.make('sk'),
  merchantPassword: Redacted.make(''),
  apiUrl: '',
  regularApiUrl: '',
  merchantDomainName: 'bill.nexttick.it',
  checkoutUrl: 'https://secure.wayforpay.com/pay',
  verifyUrl: 'https://secure.wayforpay.com/verify',
  serviceUrl: 'https://us/callback',
  returnUrl: 'https://us/checkout/{orderReference}/return',
};

const session: CheckoutSession = {
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 0,
  currency: 0, // UAH
  period: 'P1M',
  method: null,
  status: CheckoutSessionStatus.Pending,
  kind: CheckoutSessionKind.CardChange,
  paymentId: 'pay_1',
  expiresAt: new Date(0),
  createdAt: new Date(0),
};

describe('buildVerify', () => {
  const form = buildVerify(config, session);

  test('posts to the hosted verify endpoint with a 0-amount UAH lookupCard body', () => {
    expect(form.action).toBe('https://secure.wayforpay.com/verify');
    expect(form.fields['merchantAccount']).toBe('m');
    expect(form.fields['merchantDomainName']).toBe('bill.nexttick.it');
    expect(form.fields['merchantAuthType']).toBe('simpleSignature');
    expect(form.fields['apiVersion']).toBe(1);
    expect(form.fields['orderReference']).toBe('chk_1');
    expect(form.fields['amount']).toBe(0);
    expect(form.fields['currency']).toBe('UAH');
    expect(form.fields['paymentSystem']).toBe('lookupCard');
    expect(form.fields['serviceUrl']).toBe('https://us/callback');
  });

  test('fills the returnUrl template with the session id', () => {
    expect(form.fields['returnUrl']).toBe(
      'https://us/checkout/chk_1/return',
    );
  });

  test('carries the 5-field verify signature (HMAC-MD5 over the verify base)', () => {
    // HMAC-MD5 over 'm;bill.nexttick.it;chk_1;0;UAH' with key 'sk'.
    const expected = signVerify(
      {
        merchantAccount: 'm',
        merchantDomainName: 'bill.nexttick.it',
        orderReference: 'chk_1',
        amount: 0,
        currency: 'UAH',
      },
      'sk',
    );
    expect(form.fields['merchantSignature']).toBe(expected);
    expect((form.fields['merchantSignature'] as string).length).toBe(32);
  });
});
