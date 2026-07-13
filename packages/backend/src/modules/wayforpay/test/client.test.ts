import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import {
  type FetchLike,
  makeWayForPayClient,
} from '@/modules/wayforpay/client.js';

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

const fetchReturning =
  (body: unknown): FetchLike =>
  () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });

const clientFor = (body: unknown) =>
  makeWayForPayClient({
    merchantAccount: 'm',
    merchantSecretKey: 's',
    merchantPassword: 'p',
    apiUrl: 'http://x/api',
    regularApiUrl: 'http://x/reg',
    fetch: fetchReturning(body),
    rateLimiter: noLimit,
  });

it.effect('transactionList returns rows on reasonCode Ok', () =>
  clientFor({
    reasonCode: 1100,
    transactionList: [
      { orderReference: 'o1', transactionType: 'PURCHASE', createdDate: '100' },
    ],
  })
    .transactionList({ dateBegin: 1, dateEnd: 2 })
    .pipe(
      Effect.map((rows) => {
        expect(rows).toHaveLength(1);
        expect(rows[0]?.orderReference).toBe('o1');
      }),
    ),
);

it.effect(
  'transactionList fails W4pWindowTooLargeError on reasonCode 1109',
  () =>
    clientFor({ reasonCode: 1109, reason: 'too big' })
      .transactionList({ dateBegin: 1, dateEnd: 2 })
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe('W4pWindowTooLargeError');
        }),
      ),
);

it.effect('checkStatus fails W4pOrderNotFoundError on reasonCode 1127', () =>
  clientFor({ reasonCode: 1127 })
    .checkStatus('o1')
    .pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe('W4pOrderNotFoundError');
      }),
    ),
);

it.effect('regularStatus accepts 4107 (closed) as a valid state response', () =>
  clientFor({ reasonCode: 4107, status: 'Removed' })
    .regularStatus('o1')
    .pipe(
      Effect.map((status) => {
        expect(status.status).toBe('Removed');
      }),
    ),
);
