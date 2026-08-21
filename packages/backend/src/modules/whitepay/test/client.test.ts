import { Currency } from '@billing-service/shared';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import {
  type FetchLike,
  makeWhitePayClient,
} from '@/modules/whitepay/client.js';

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch spy: records the request and returns the given body/status. */
const spyFetch = (
  calls: Call[],
  response: { ok: boolean; status: number; body: unknown },
): FetchLike => {
  return (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(JSON.stringify(response.body)),
    });
  };
};

const clientWith = (calls: Call[], response: Parameters<typeof spyFetch>[1]) =>
  makeWhitePayClient({
    slug: 'my-slug',
    apiToken: 'tok_123',
    apiUrl: 'https://api.whitepay.test',
    successfulLink: 'https://bill.test/checkout/{sessionId}/return',
    failureLink: 'https://bill.test/checkout/{sessionId}',
    fetch: spyFetch(calls, response),
    rateLimiter: noLimit,
  });

const params = {
  amount: 1050,
  currency: Currency.USD,
  externalOrderId: 'chk_1',
} as const;

it.effect(
  'createOrder posts the fiat body with Bearer auth to the slug path',
  () => {
    const calls: Call[] = [];
    return clientWith(calls, {
      ok: true,
      status: 200,
      body: { order: { id: 'ord_9', acquiring_url: 'https://pay/ord_9' } },
    })
      .createOrder(params)
      .pipe(
        Effect.map((created) => {
          expect(created.id).toBe('ord_9');
          expect(created.acquiringUrl).toBe('https://pay/ord_9');
          const call = calls[0];
          expect(call?.url).toBe(
            'https://api.whitepay.test/private-api/crypto-orders/my-slug',
          );
          expect(call?.headers['Authorization']).toBe('Bearer tok_123');
          const sent = JSON.parse(call?.body ?? '{}') as Record<
            string,
            unknown
          >;
          expect(sent['amount']).toBe(10.5); // minor → major, fiat-denominated
          expect(sent['currency']).toBe('USD');
          expect(sent['external_order_id']).toBe('chk_1');
          expect(sent['successful_link']).toBe(
            'https://bill.test/checkout/chk_1/return',
          );
        }),
      );
  },
  30_000,
);

it.effect(
  'createOrder tolerates a flat order (no envelope)',
  () => {
    const calls: Call[] = [];
    return clientWith(calls, {
      ok: true,
      status: 200,
      body: {
        id: 'ord_flat',
        acquiring_url: 'https://pay/flat',
        status: 'OPEN',
      },
    })
      .createOrder(params)
      .pipe(
        Effect.map((created) => {
          expect(created.id).toBe('ord_flat');
          expect(created.status).toBe('OPEN');
        }),
      );
  },
  30_000,
);

it.effect(
  'createOrder fails WhitePayResponseError when acquiring_url is missing',
  () => {
    const calls: Call[] = [];
    return clientWith(calls, {
      ok: true,
      status: 200,
      body: { order: { id: 'ord_9' } },
    })
      .createOrder(params)
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe('WhitePayResponseError');
        }),
      );
  },
  30_000,
);

it.effect(
  'createOrder fails WhitePayTransportError on a non-transient non-4xx-reject status',
  () => {
    // 404 is neither a 400/422 request-reject nor transient (429/5xx), so it fails fast
    // as a transport error without the retry backoff that would suspend on the test clock.
    const calls: Call[] = [];
    return clientWith(calls, {
      ok: false,
      status: 404,
      body: { error: 'boom' },
    })
      .createOrder(params)
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe('WhitePayTransportError');
        }),
      );
  },
  30_000,
);

it.effect(
  'createOrder fails CryptoOrderRejected (422) carrying the provider message',
  () => {
    // Below the WhitePay minimum order value → HTTP 422 {message, errors}. A permanent
    // client-reject, surfaced as 422 with the provider message, not a retryable 502.
    const calls: Call[] = [];
    return clientWith(calls, {
      ok: false,
      status: 422,
      body: { message: 'Мін: 216.80 UAH', errors: { amount: ['too small'] } },
    })
      .createOrder(params)
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe('CryptoOrderRejected');
          expect((error as { reason: string }).reason).toContain('216.80');
        }),
      );
  },
  30_000,
);
