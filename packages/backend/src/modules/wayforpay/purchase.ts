import { type CheckoutSession, CurrencyCode } from '@billing-service/shared';
import { Redacted } from 'effect';

import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import { signPurchase, signVerify } from '@/modules/wayforpay/signature.js';

/** A ready-to-submit WayForPay Purchase form: POST `fields` to `action`. */
export interface PurchaseForm {
  readonly action: string;
  readonly fields: Record<string, unknown>;
}

/**
 * Build a signed WayForPay Purchase (docs/14 flow A). No `regularMode`: we take the
 * recToken from the callback and run our own billing cycle, so we must not let
 * WayForPay create its own managed schedule (the migration gotcha). Amount is sent
 * in major units, which is also what the signature covers.
 */
export const buildPurchase = (
  config: W4pConfigService,
  session: CheckoutSession,
  orderDate: number,
): PurchaseForm => {
  const amount = session.amount / 100;
  const currency = CurrencyCode[session.currency];
  const productName = `Payment ${session.period}`;
  const merchantSignature = signPurchase(
    {
      merchantAccount: config.merchantAccount,
      merchantDomainName: config.merchantDomainName,
      orderReference: session.id,
      orderDate,
      amount,
      currency,
      products: [{ name: productName, count: 1, price: amount }],
    },
    Redacted.value(config.merchantSecretKey),
  );
  return {
    action: config.checkoutUrl,
    fields: {
      merchantAccount: config.merchantAccount,
      merchantDomainName: config.merchantDomainName,
      merchantSignature,
      orderReference: session.id,
      orderDate,
      amount,
      currency,
      productName: [productName],
      productCount: [1],
      productPrice: [amount],
      serviceUrl: config.serviceUrl,
      // returnUrl is a template (…/checkout/{orderReference}/return); fill the token
      // with this order's reference (= the session id) so the browser lands on the
      // real return page, not a literal `{orderReference}`.
      returnUrl: config.returnUrl.replace('{orderReference}', session.id),
    },
  };
};

/**
 * Build a signed WayForPay Card Verify (0-amount tokenization, wiki 852189 / docs/24)
 * as a ready-to-submit form — the SAME handoff shape as {@link buildPurchase}. The
 * hosted `/verify` needs a real browser FORM POST (top-level navigation), not a
 * server-side JSON request, so the browser submits `fields` to `action` directly and
 * the cardholder fills in the widget. A verify holds no money: amount is 0 and
 * currency UAH, and the 5-field signature covers exactly account;domain;order;amount;currency.
 */
export const buildVerify = (
  config: W4pConfigService,
  session: CheckoutSession,
): PurchaseForm => ({
  action: config.verifyUrl,
  fields: {
    merchantAccount: config.merchantAccount,
    merchantDomainName: config.merchantDomainName,
    merchantAuthType: 'simpleSignature',
    merchantSignature: signVerify(
      {
        merchantAccount: config.merchantAccount,
        merchantDomainName: config.merchantDomainName,
        orderReference: session.id,
        amount: 0,
        currency: 'UAH',
      },
      Redacted.value(config.merchantSecretKey),
    ),
    apiVersion: 1,
    orderReference: session.id,
    amount: 0,
    currency: 'UAH',
    paymentSystem: 'lookupCard',
    // returnUrl is a template (…/checkout/{orderReference}/return); fill the token so
    // the browser lands on the real return page, not a literal `{orderReference}`.
    returnUrl: config.returnUrl.replace('{orderReference}', session.id),
    serviceUrl: config.serviceUrl,
  },
});
