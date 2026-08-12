import { Effect } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { FetchLike } from '@/modules/wayforpay/client.js';
import { W4pTransportError } from '@/modules/wayforpay/errors.js';
import { signVerify } from '@/modules/wayforpay/signature.js';

/**
 * WayForPay Card Verify — 0-amount tokenization (wiki 852189, docs/24). Unlike the
 * JSON `/api` endpoints, `/verify` answers a correctly-signed server-side JSON POST
 * with HTTP 200 text/html: the hosted card-verify WIDGET the cardholder fills in
 * (live-confirmed against merchant nexttick_it1). So this path does NOT decode JSON
 * — it returns the HTML verbatim — and therefore lives outside the client's shared
 * `postJson`/`decode` machinery.
 */

export interface VerifyDeps {
  readonly merchantAccount: string;
  readonly merchantSecretKey: string;
  readonly merchantDomainName: string;
  readonly verifyUrl: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

export interface VerifyParams {
  readonly orderReference: string;
  readonly returnUrl: string;
  readonly serviceUrl: string;
}

const ENDPOINT = 'CARD_VERIFY';

/**
 * The widget's markup loads assets by relative path (`/assets/...`); served from our
 * origin those 404, so we inject a `<base href>` pointing at WayForPay right after
 * `<head>` and the browser resolves every relative URL against it.
 */
const injectBase = (html: string): string =>
  html.replace(
    /<head(\s[^>]*)?>/i,
    (match) => `${match}<base href="https://secure.wayforpay.com/">`,
  );

/** Build the signed JSON verify body. amount is 0 and currency UAH (a verify holds
 * no money); the 5-field signature covers exactly account;domain;order;amount;currency. */
const verifyBody = (deps: VerifyDeps, params: VerifyParams) => ({
  merchantAccount: deps.merchantAccount,
  merchantDomainName: deps.merchantDomainName,
  merchantAuthType: 'simpleSignature',
  merchantSignature: signVerify(
    {
      merchantAccount: deps.merchantAccount,
      merchantDomainName: deps.merchantDomainName,
      orderReference: params.orderReference,
      amount: 0,
      currency: 'UAH',
    },
    deps.merchantSecretKey,
  ),
  apiVersion: 1,
  orderReference: params.orderReference,
  amount: 0,
  currency: 'UAH',
  paymentSystem: 'lookupCard',
  returnUrl: params.returnUrl,
  serviceUrl: params.serviceUrl,
});

const isTransient = (error: W4pTransportError): boolean =>
  error.status === undefined || isTransientStatus(error.status);

export const requestVerifyPage = (
  deps: VerifyDeps,
  params: VerifyParams,
): Effect.Effect<string, W4pTransportError> => {
  const request = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await deps.fetch(deps.verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(verifyBody(deps, params)),
          signal,
        });
        return { ok: res.ok, status: res.status, raw: await res.text() };
      },
      catch: (cause) => new W4pTransportError({ endpoint: ENDPOINT, cause }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new W4pTransportError({
          endpoint: ENDPOINT,
          status: response.status,
          body: response.raw,
        }),
      );
    }
    return injectBase(response.raw);
  });
  return deps.rateLimiter.limit(retryTransient(request, isTransient));
};
