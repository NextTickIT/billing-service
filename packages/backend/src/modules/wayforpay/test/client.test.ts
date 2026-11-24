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

/** A fetch that answers `body` and keeps every request body it was sent. */
const recordingFetch = (body: unknown) => {
  const sent: Record<string, unknown>[] = [];
  const fetch: FetchLike = (_url, init) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return fetchReturning(body)(_url, init);
  };
  return { sent, fetch };
};

const clientFor = (body: unknown) =>
  makeWayForPayClient({
    merchantAccount: 'm',
    merchantSecretKey: 's',
    merchantPassword: 'p',
    merchantDomainName: 'd',
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

it.effect(
  'checkStatus keeps the status and processing time of an order held for the 3-D Secure code',
  () =>
    clientFor({
      reasonCode: 5110,
      reason: 'Ok',
      orderReference: 'o1',
      transactionStatus: 'WaitingOtpConfirm',
      processingDate: 1795532501,
    })
      .checkStatus('o1')
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toMatchObject({
            _tag: 'W4pApiError',
            reasonCode: 5110,
            transactionStatus: 'WaitingOtpConfirm',
            processingDate: 1795532501,
          });
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

it.effect('charge returns a Declined response rather than failing', () =>
  clientFor({
    transactionStatus: 'Declined',
    reasonCode: 1104,
    reason: 'Insufficient funds',
  })
    .charge({
      orderReference: 'sub_1_100',
      amount: 30000,
      currency: 0,
      recToken: 'tok',
      orderDate: 100,
      productName: 'Subscription P1M',
    })
    .pipe(
      Effect.map((response) => {
        expect(response.transactionStatus).toBe('Declined');
        expect(response.reason).toBe('Insufficient funds');
      }),
    ),
);

it.effect('refund sends a signed v1 REFUND of the major-unit amount', () => {
  const wire = recordingFetch({
    transactionStatus: 'Refunded',
    reasonCode: 1100,
  });
  const client = makeWayForPayClient({
    merchantAccount: 'm',
    merchantSecretKey: 's',
    merchantPassword: 'p',
    merchantDomainName: 'd',
    apiUrl: 'http://x/api',
    regularApiUrl: 'http://x/reg',
    fetch: wire.fetch,
    rateLimiter: noLimit,
  });
  return client
    .refund({
      orderReference: 'chk_1',
      amount: 100,
      currency: 1,
      comment: 'Card verification refund',
    })
    .pipe(
      Effect.map((response) => {
        expect(response.transactionStatus).toBe('Refunded');
        expect(wire.sent[0]).toMatchObject({
          apiVersion: 1,
          transactionType: 'REFUND',
          merchantAccount: 'm',
          orderReference: 'chk_1',
          amount: 1,
          currency: 'USD',
          comment: 'Card verification refund',
        });
        expect(String(wire.sent[0]?.['merchantSignature'])).toHaveLength(32);
      }),
    );
});

it.effect('refund returns a Declined response rather than failing', () =>
  clientFor({ transactionStatus: 'Declined', reasonCode: 1112 })
    .refund({
      orderReference: 'chk_1',
      amount: 100,
      currency: 1,
      comment: 'Card verification refund',
    })
    .pipe(
      Effect.map((response) => {
        expect(response.transactionStatus).toBe('Declined');
        expect(response.reasonCode).toBe(1112);
      }),
    ),
);

it.effect(
  'refund sends ONE request: a 503 is returned to the caller, not retried',
  () => {
    let requests = 0;
    const client = makeWayForPayClient({
      merchantAccount: 'm',
      merchantSecretKey: 's',
      merchantPassword: 'p',
      merchantDomainName: 'd',
      apiUrl: 'http://x/api',
      regularApiUrl: 'http://x/reg',
      fetch: () => {
        requests += 1;
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve(''),
        });
      },
      rateLimiter: noLimit,
    });
    return client
      .refund({
        orderReference: 'chk_1',
        amount: 100,
        currency: 1,
        comment: 'Card verification refund',
      })
      .pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe('W4pTransportError');
          expect(requests).toBe(1);
        }),
      );
  },
);
