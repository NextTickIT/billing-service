import { describe, expect, it } from '@effect/vitest';

import { describeError, isPermanentFailure } from '@/infra/queue/policy.js';
import {
  RECEIPT_SWEEP_MAX_REVIVALS,
  sweepAction,
  type UnsettledOrder,
} from '@/modules/billing/receipt-sweep.js';
import { ReceiptUndecodable } from '@/modules/charge/contracts.js';

const order = (over: Partial<UnsettledOrder> = {}): UnsettledOrder => ({
  ref: 'sub_1_1',
  revivable: 1,
  live: 0,
  revivals: 0,
  ...over,
});

describe('sweepAction: what the sweep does with an approved, unsettled order', () => {
  it.each([
    ['a receipt a worker still holds', order({ live: 1 }), 'wait'],
    [
      'a worker still holds one, even past the revival limit',
      order({ live: 1, revivals: RECEIPT_SWEEP_MAX_REVIVALS }),
      'wait',
    ],
    ['a revivable receipt, never revived', order(), 'revive'],
    [
      'a revivable receipt, one revival short of the limit',
      order({ revivals: RECEIPT_SWEEP_MAX_REVIVALS - 1 }),
      'revive',
    ],
    [
      'a revivable receipt at the revival limit',
      order({ revivals: RECEIPT_SWEEP_MAX_REVIVALS }),
      'alert',
    ],
    ['no receipt at all', order({ revivable: 0 }), 'alert'],
  ])('%s → %s', (_label, input, expected) => {
    expect(sweepAction(input)).toBe(expected);
  });
});

describe('ReceiptUndecodable', () => {
  it('dead-letters on its first attempt and is recorded under its code', () => {
    const error = new ReceiptUndecodable({ message: 'invalid payload' });

    expect(isPermanentFailure(error)).toBe(true);
    expect(describeError(error)).toMatchObject({
      code: 'receipt_undecodable',
      message: 'invalid payload',
    });
  });
});
