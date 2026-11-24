import { describe, expect, it } from '@effect/vitest';

import { verdictOf } from '@/modules/checkout/card-check-stall.js';

const NOW = Date.parse('2026-11-24T16:00:00Z');
const secondsAgo = (minutes: number, seconds = 0): number =>
  Math.floor(NOW / 1000) - minutes * 60 - seconds;

describe('verdictOf', () => {
  it.each([
    ['a refused order', 'Declined', undefined, 'stuck'],
    ['an expired order', 'Expired', undefined, 'stuck'],
    [
      'a challenge unanswered past the stall delay',
      'WaitingOtpConfirm',
      secondsAgo(15, 1),
      'stuck',
    ],
    [
      'a challenge exactly on the stall delay',
      'WaitingOtpConfirm',
      secondsAgo(15),
      'stuck',
    ],
    [
      'a challenge just under the stall delay',
      'WaitingOtpConfirm',
      secondsAgo(14, 59),
      'leave',
    ],
    [
      'a challenge with its time as text',
      'WaitingOtpConfirm',
      String(secondsAgo(20)),
      'stuck',
    ],
    [
      'a challenge with no processing time',
      'WaitingOtpConfirm',
      undefined,
      'leave',
    ],
    [
      'a challenge with an unreadable processing time',
      'WaitingOtpConfirm',
      'yesterday',
      'leave',
    ],
    ['an order in antifraud review', 'Pending', secondsAgo(60), 'leave'],
    ['an order still processing', 'InProcessing', secondsAgo(60), 'leave'],
    ['a verified card', 'WaitingAuthComplete', secondsAgo(60), 'leave'],
    ['an approved charge', 'Approved', secondsAgo(60), 'leave'],
    ['an order with no status', undefined, secondsAgo(60), 'leave'],
  ] as const)('%s is %s', (_, transactionStatus, processingDate, expected) => {
    const verdict = verdictOf({ transactionStatus, processingDate }, NOW);

    expect(verdict).toBe(expected);
  });
});
