import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import { W4pTransportError } from '@/modules/wayforpay/errors.js';
import {
  attemptRefund,
  reconcileRefund,
  refundAnswer,
} from '@/modules/wayforpay/refund.js';

const ORDER = {
  orderReference: 'chk_cc',
  amount: 100,
  currency: 1,
  comment: 'Card verification refund',
} as const;

describe('refundAnswer: what the provider said about the money', () => {
  it.each([
    ['Refunded, code Ok', 'Refunded', 1100, { kind: 'returned' }],
    ['Voided, code Ok as text', 'Voided', '1100', { kind: 'returned' }],
    [
      'lowercase refunded (the documented example)',
      'refunded',
      1100,
      { kind: 'returned' },
    ],
    [
      'Refunded with another code',
      'Refunded',
      1112,
      { kind: 'refused', reasonCode: '1112' },
    ],
    [
      'Refunded without a code',
      'Refunded',
      undefined,
      { kind: 'refused', reasonCode: null },
    ],
    [
      'RefundInProcessing',
      'RefundInProcessing',
      1100,
      { kind: 'retry', reason: 'RefundInProcessing' },
    ],
    ['Declined', 'Declined', 1112, { kind: 'refused', reasonCode: '1112' }],
    [
      'the order still Approved',
      'Approved',
      '1100',
      { kind: 'refused', reasonCode: '1100' },
    ],
  ] as const)('%s', (_label, transactionStatus, reasonCode, expected) => {
    expect(refundAnswer({ transactionStatus, reasonCode })).toEqual(expected);
  });
});

type Answer = Effect.Effect<
  { readonly transactionStatus: string; readonly reasonCode: number },
  W4pTransportError
>;

/** A provider that answers REFUND and CHECK_STATUS as told and counts the calls. */
const provider = (answers: {
  readonly refund: Answer;
  readonly status?: string;
}) => {
  const calls = { refund: 0, checkStatus: 0 };
  const client: Pick<WayForPayClient, 'refund' | 'checkStatus'> = {
    refund: () =>
      Effect.sync(() => {
        calls.refund += 1;
      }).pipe(Effect.andThen(answers.refund)),
    checkStatus: () =>
      Effect.sync(() => {
        calls.checkStatus += 1;
      }).pipe(
        Effect.as({
          transactionStatus: answers.status ?? 'Approved',
          reasonCode: 1100,
        }),
      ),
  };
  return { calls, client };
};

const REFUNDED: Answer = Effect.succeed({
  transactionStatus: 'Refunded',
  reasonCode: 1100,
});
const TRANSPORT_DOWN: Answer = Effect.fail(
  new W4pTransportError({ endpoint: 'REFUND', status: 503 }),
);

describe('attemptRefund: one refund attempt', () => {
  it.effect('a first attempt refunds without asking the status first', () =>
    Effect.gen(function* () {
      const wfp = provider({ refund: REFUNDED });

      const result = yield* attemptRefund(wfp.client, ORDER, false);

      expect(result).toEqual({ kind: 'returned' });
      expect(wfp.calls).toEqual({ refund: 1, checkStatus: 0 });
    }),
  );

  it.effect(
    'after an unanswered attempt, money already returned is not refunded again',
    () =>
      Effect.gen(function* () {
        const wfp = provider({ refund: REFUNDED, status: 'Refunded' });

        const result = yield* attemptRefund(wfp.client, ORDER, true);

        expect(result).toEqual({ kind: 'returned' });
        expect(wfp.calls.refund).toBe(0);
      }),
  );

  it.effect(
    'after an unanswered attempt, an order still charged is refunded',
    () =>
      Effect.gen(function* () {
        const wfp = provider({ refund: REFUNDED, status: 'Approved' });

        const result = yield* attemptRefund(wfp.client, ORDER, true);

        expect(result).toEqual({ kind: 'returned' });
        expect(wfp.calls).toEqual({ refund: 1, checkStatus: 1 });
      }),
  );

  it.effect(
    'a refund still in processing is asked about again, not refunded again',
    () =>
      Effect.gen(function* () {
        const wfp = provider({
          refund: REFUNDED,
          status: 'RefundInProcessing',
        });

        const result = yield* attemptRefund(wfp.client, ORDER, true);

        expect(result).toEqual({ kind: 'retry', reason: 'RefundInProcessing' });
        expect(wfp.calls.refund).toBe(0);
      }),
  );

  it.effect('a transport failure is a retry, not a refusal', () =>
    Effect.gen(function* () {
      const wfp = provider({ refund: TRANSPORT_DOWN });

      const result = yield* attemptRefund(wfp.client, ORDER, false);

      expect(result).toEqual({ kind: 'retry', reason: 'W4pTransportError' });
    }),
  );
});

describe('reconcileRefund: past the budget, only the order status is asked', () => {
  it.each([
    ['Refunded', { kind: 'returned' }],
    ['RefundInProcessing', { kind: 'retry', reason: 'RefundInProcessing' }],
    ['Approved', { kind: 'refused', reasonCode: null }],
  ] as const)('an order %s → %o, and no REFUND', (status, expected) =>
    Effect.gen(function* () {
      const wfp = provider({ refund: REFUNDED, status });

      const result = yield* reconcileRefund(wfp.client, ORDER.orderReference);

      expect(result).toEqual(expected);
      expect(wfp.calls.refund).toBe(0);
    }).pipe(Effect.runPromise),
  );
});
