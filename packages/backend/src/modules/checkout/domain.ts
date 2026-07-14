import { type CheckoutSession, CurrencyCode } from '@billing-service/shared';
import { Redacted } from 'effect';

import type { W4pConfigService } from '@/modules/wayforpay/config.js';
import { signPurchase } from '@/modules/wayforpay/signature.js';

/** The public checkout page path for a session id (the CRM prepends the host). */
export const checkoutPath = (sessionId: string): string =>
  `/checkout/${sessionId}`;

/** A ready-to-submit WayForPay Purchase form: POST `fields` to `action`. */
export interface PurchaseForm {
  readonly action: string;
  readonly fields: Record<string, unknown>;
}

/**
 * Build a signed WayForPay Purchase (docs/14 flow A). No `regularMode`: we take
 * the recToken from the callback and run our own billing cycle, so we must not let
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
  const productName = `Subscription ${session.period}`;
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
      returnUrl: config.returnUrl,
    },
  };
};
