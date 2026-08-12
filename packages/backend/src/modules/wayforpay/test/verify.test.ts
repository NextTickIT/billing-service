import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { FetchLike } from '@/modules/wayforpay/client.js';
import {
  requestVerifyPage,
  type VerifyDeps,
} from '@/modules/wayforpay/verify.js';

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch fake that records the request and returns a 200 text/html widget page. */
const recordingFetch =
  (captured: Captured[], html: string): FetchLike =>
  (url, init) => {
    captured.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(html),
    });
  };

const depsWith = (fetch: FetchLike): VerifyDeps => ({
  merchantAccount: 'm',
  merchantSecretKey: 'sk',
  merchantDomainName: 'd',
  verifyUrl: 'http://x/verify',
  fetch,
  rateLimiter: noLimit,
});

const params = {
  orderReference: 'chk_1',
  returnUrl: 'https://us/return',
  serviceUrl: 'https://us/callback',
};

it.effect('posts the signed verify JSON body to the verify URL', () => {
  const captured: Captured[] = [];
  return requestVerifyPage(
    depsWith(recordingFetch(captured, '<html><head></head></html>')),
    params,
  ).pipe(
    Effect.map(() => {
      const req = captured[0];
      expect(req?.url).toBe('http://x/verify');
      expect(req?.headers['Content-Type']).toBe('application/json');
      expect(req?.body).toMatchObject({
        merchantAccount: 'm',
        merchantDomainName: 'd',
        merchantAuthType: 'simpleSignature',
        apiVersion: 1,
        orderReference: 'chk_1',
        amount: 0,
        currency: 'UAH',
        paymentSystem: 'lookupCard',
        returnUrl: 'https://us/return',
        serviceUrl: 'https://us/callback',
        // HMAC-MD5 over 'm;d;chk_1;0;UAH' with key 'sk'.
        merchantSignature: 'cd8dd6eb04f20aeaeb7d6d8343c4b272',
      });
    }),
  );
});

it.effect(
  'injects <base> after <head> so relative widget assets resolve',
  () => {
    const captured: Captured[] = [];
    return requestVerifyPage(
      depsWith(
        recordingFetch(captured, '<html><head><title>x</title></head></html>'),
      ),
      params,
    ).pipe(
      Effect.map((html) => {
        expect(html).toContain('<base href="https://secure.wayforpay.com/">');
        // The base tag comes right after <head>, before the original head content.
        expect(html).toContain(
          '<head><base href="https://secure.wayforpay.com/"><title>x</title>',
        );
      }),
    );
  },
);

it.effect('fails W4pTransportError on a non-2xx response', () => {
  const failing: FetchLike = () =>
    Promise.resolve({
      ok: false,
      status: 405,
      text: () => Promise.resolve('Method Not Allowed'),
    });
  return requestVerifyPage(depsWith(failing), params).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error._tag).toBe('W4pTransportError');
      expect(error.status).toBe(405);
    }),
  );
});
