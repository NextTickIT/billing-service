import { type CheckoutSession, CurrencyCode } from '@billing-service/shared';
import { Redacted } from 'effect';

import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import { signPurchase, signVerify } from '@/modules/wayforpay/signature.js';

/** A ready-to-submit WayForPay Purchase form: POST `fields` to `action`. `kind`
 * discriminates it from a crypto redirect in the shared `PayInstruction` union. */
export interface PurchaseForm {
  readonly kind: 'form';
  readonly action: string;
  readonly fields: Record<string, unknown>;
}

/**
 * Never hand out an order with less life left than this. A buyer who opens the link in
 * its final seconds would otherwise get a form that is already dead at the provider.
 */
const MIN_ORDER_TIMEOUT_SECONDS = 300;

/**
 * How long WayForPay keeps this order payable, in seconds — optional on the hosted
 * Purchase form (wiki 852102), and NOT part of the signature base (see
 * `purchaseSignatureBase`), so sending it is purely additive.
 *
 * Derived from what is LEFT of our session TTL, never the full TTL, so the two clocks
 * track each other instead of drifting: a link that still looks payable never hands back
 * an order the provider already expired. The floor is the one deliberate exception — an
 * order minted in the link's last moments outlives it by up to five minutes, which is
 * preferable to handing out a form that is dead on arrival. Sending
 * nothing (as we used to) inherits WayForPay's own default, which is unrelated to our
 * TTL — that gap is what leaves a buyer staring at a live Pay button on a dead order.
 */
const orderTimeoutFor = (session: CheckoutSession, orderDate: number): number =>
  Math.max(
    MIN_ORDER_TIMEOUT_SECONDS,
    Math.floor(session.expiresAt.getTime() / 1000) - orderDate,
  );

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
    kind: 'form',
    action: config.checkoutUrl,
    fields: {
      merchantAccount: config.merchantAccount,
      merchantDomainName: config.merchantDomainName,
      merchantSignature,
      orderReference: session.id,
      orderDate,
      orderTimeout: orderTimeoutFor(session, orderDate),
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
 * Build a signed WayForPay Card Verify (0-amount tokenization, wiki 852189) as a
 * ready-to-submit form — same handoff as {@link buildPurchase}, but the browser FORM-
 * POSTs it to the hosted `/verify` (a server-side JSON request is rejected there). A
 * verify holds no money: amount 0, currency UAH; the signature covers
 * account;domain;order;amount;currency.
 */
export const buildVerify = (
  config: W4pConfigService,
  session: CheckoutSession,
): PurchaseForm => ({
  kind: 'form',
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
