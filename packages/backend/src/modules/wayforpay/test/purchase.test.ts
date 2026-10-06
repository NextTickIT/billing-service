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

const session = (expiresAt: Date) => ({
  id: 'chk_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0 as const, // UAH
  period: 'P1M',
  method: 0,
  status: CheckoutSessionStatus.Pending,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  idempotencyKey: null,
  metadata: null,
  expiresAt,
  createdAt: new Date(0),
});

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
      recurring: true,
      paymentId: null,
      successUrl: null,
      failureUrl: null,
      promo: null,
      idempotencyKey: null,
      metadata: null,
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

describe('orderTimeout keeps the provider order and our link on one clock', () => {
  const orderDate = 1700000000;

  test('expires the provider order exactly when the session does', () => {
    // 2h of session TTL left at hand-out → the order lives those same 2h, not
    // WayForPay's unrelated default.
    const form = buildPurchase(
      config,
      session(new Date((orderDate + 7200) * 1000)),
      orderDate,
    );
    expect(form.fields['orderTimeout']).toBe(7200);
  });

  test('never hands out an order with less than the floor left', () => {
    // Opened in the link's final seconds: without the floor the buyer would get a form
    // that is already dead at the provider.
    const form = buildPurchase(
      config,
      session(new Date((orderDate + 10) * 1000)),
      orderDate,
    );
    expect(form.fields['orderTimeout']).toBe(300);
  });

  test('an already-expired session still gets the floor, never a negative timeout', () => {
    const form = buildPurchase(
      config,
      session(new Date((orderDate - 3600) * 1000)),
      orderDate,
    );
    expect(form.fields['orderTimeout']).toBe(300);
  });

  test('orderTimeout is outside the signature base, so it cannot break signing', () => {
    const withTimeout = buildPurchase(
      config,
      session(new Date((orderDate + 7200) * 1000)),
      orderDate,
    );
    const withDifferentTimeout = buildPurchase(
      config,
      session(new Date((orderDate + 60) * 1000)),
      orderDate,
    );
    expect(withTimeout.fields['orderTimeout']).not.toBe(
      withDifferentTimeout.fields['orderTimeout'],
    );
    expect(withTimeout.fields['merchantSignature']).toBe(
      withDifferentTimeout.fields['merchantSignature'],
    );
  });
});
