import { createHmac } from 'node:crypto';

/**
 * WayForPay request signing (HMAC-MD5). Each request carries
 * `merchantSignature = HMAC_MD5(base, merchantSecretKey)`, where `base` is a
 * `;`-joined UTF-8 concatenation of a per-request-type field set. The field ORDER
 * differs per type and is the most common source of mistakes, so it lives in an
 * explicit table covered by fixed test vectors.
 *
 * regularApi (STATUS/…) does NOT sign — it uses `merchantPassword` instead.
 */

export type SignedRequestType = 'TRANSACTION_LIST' | 'CHECK_STATUS';

export const SIGNATURE_FIELD_ORDER = {
  // Source: Transaction list (wiki 1736786).
  TRANSACTION_LIST: ['merchantAccount', 'dateBegin', 'dateEnd'],
  // Source: Check Status (wiki 852117).
  CHECK_STATUS: ['merchantAccount', 'orderReference'],
} as const satisfies Record<SignedRequestType, readonly string[]>;

export const hmacMd5Hex = (base: string, secretKey: string): string =>
  createHmac('md5', secretKey).update(base, 'utf8').digest('hex');

/**
 * Assemble the signature base: field values in {@link SIGNATURE_FIELD_ORDER},
 * `;`-joined. Numbers render as their decimal string, matching how the server
 * sees them in the request body.
 */
export const buildSignatureBase = (
  requestType: SignedRequestType,
  fields: Readonly<Record<string, string | number>>,
): string =>
  SIGNATURE_FIELD_ORDER[requestType]
    .map((key) => {
      const value = fields[key];
      if (value === undefined) {
        throw new Error(
          `buildSignatureBase: missing field '${key}' for ${requestType}`,
        );
      }
      return String(value);
    })
    .join(';');

export const signRequest = (
  requestType: SignedRequestType,
  fields: Readonly<Record<string, string | number>>,
  secretKey: string,
): string => hmacMd5Hex(buildSignatureBase(requestType, fields), secretKey);

export interface PurchaseProduct {
  readonly name: string;
  readonly count: number;
  readonly price: number;
}

export interface PurchaseSignatureFields {
  readonly merchantAccount: string;
  readonly merchantDomainName: string;
  readonly orderReference: string;
  readonly orderDate: number;
  readonly amount: number;
  readonly currency: string;
  readonly products: readonly PurchaseProduct[];
}

/**
 * Purchase / CHARGE signature base (wiki 852102 / 852194): the six head fields,
 * then ALL productName, then ALL productCount, then ALL productPrice — each group
 * flattened in product order. Card/token fields are not signed.
 */
export const purchaseSignatureBase = (f: PurchaseSignatureFields): string =>
  [
    f.merchantAccount,
    f.merchantDomainName,
    f.orderReference,
    String(f.orderDate),
    String(f.amount),
    f.currency,
    ...f.products.map((p) => p.name),
    ...f.products.map((p) => String(p.count)),
    ...f.products.map((p) => String(p.price)),
  ].join(';');

export const signPurchase = (
  f: PurchaseSignatureFields,
  secretKey: string,
): string => hmacMd5Hex(purchaseSignatureBase(f), secretKey);

export interface CallbackSignatureFields {
  readonly merchantAccount: string;
  readonly orderReference: string;
  readonly amount: string;
  readonly currency: string;
  readonly authCode: string;
  readonly cardPan: string;
  readonly transactionStatus: string;
  readonly reasonCode: string;
}

/**
 * serviceUrl callback signature base (wiki 852102): exactly these eight fields,
 * verified over the values AS RECEIVED (so amount/reasonCode are the raw strings).
 */
export const callbackSignatureBase = (f: CallbackSignatureFields): string =>
  [
    f.merchantAccount,
    f.orderReference,
    f.amount,
    f.currency,
    f.authCode,
    f.cardPan,
    f.transactionStatus,
    f.reasonCode,
  ].join(';');

/** Our acknowledgement signature: `orderReference;status;time` (wiki 852102). */
export const ackSignatureBase = (
  orderReference: string,
  status: string,
  time: number,
): string => [orderReference, status, String(time)].join(';');
