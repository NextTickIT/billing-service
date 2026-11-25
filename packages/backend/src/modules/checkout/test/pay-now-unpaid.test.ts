import { describe, expect, it } from '@effect/vitest';

import {
  type UnpaidAnswer,
  unpaidVerdictOf,
} from '@/modules/checkout/pay-now-unpaid.js';

const NOW = Date.parse('2026-11-25T23:45:00Z');
const secondsAgo = (minutes: number, seconds = 0): number =>
  Math.floor(NOW / 1000) - minutes * 60 - seconds;

const order = (
  transactionStatus: string | undefined,
  processingDate?: number | string,
): UnpaidAnswer => ({
  kind: 'order',
  order: { transactionStatus, processingDate },
});

describe('unpaidVerdictOf', () => {
  it.each([
    ['a declined order', order('Declined', secondsAgo(60)), 'close'],
    ['an expired order', order('Expired', secondsAgo(60)), 'close'],
    ['an order WayForPay never saw', { kind: 'not_found' }, 'close'],
    [
      'a bank confirmation unanswered past the delay',
      order('WaitingOtpConfirm', secondsAgo(15, 1)),
      'close',
    ],
    [
      'a bank confirmation exactly on the delay',
      order('WaitingOtpConfirm', secondsAgo(15)),
      'close',
    ],
    [
      'a bank confirmation just under the delay',
      order('WaitingOtpConfirm', secondsAgo(14, 59)),
      'leave',
    ],
    [
      'a bank confirmation with no processing time',
      order('WaitingOtpConfirm'),
      'leave',
    ],
    ['an approved order', order('Approved', secondsAgo(60)), 'leave'],
    [
      'an order still processing',
      order('InProcessing', secondsAgo(60)),
      'leave',
    ],
    [
      'an order awaiting completion',
      order('WaitingAuthComplete', secondsAgo(60)),
      'leave',
    ],
    ['an order in antifraud review', order('Pending', secondsAgo(60)), 'leave'],
    [
      'an order in a status we do not know',
      order('Voided', secondsAgo(60)),
      'leave',
    ],
    ['an order with no status', order(undefined, secondsAgo(60)), 'leave'],
    ['an answer we could not read', { kind: 'unreadable' }, 'leave'],
  ] as const)('%s is %s', (_, answer, expected) => {
    const verdict = unpaidVerdictOf(answer, NOW);

    expect(verdict).toBe(expected);
  });
});
