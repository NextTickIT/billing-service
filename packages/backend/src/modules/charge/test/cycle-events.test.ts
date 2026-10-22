import { describe, expect, it } from 'vitest';

import type { Charge, Match } from '@/modules/charge/contracts.js';
import {
  initialPaymentFailed,
  initialPaymentSucceeded,
  paymentCreated,
  recurringPaymentFailed,
  recurringPaymentSucceeded,
} from '@/modules/charge/domain.js';

const event: Charge = {
  source: 'whitepay_callback',
  idemKey: 'k',
  externalRef: 'chk_0b5e6a3c-1f2d-4c7b-9a8e-1234567890ab_c3',
  externalUserId: null,
  amount: 15000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date('2026-01-15T00:00:00Z'),
  payload: {},
};

const match: Match = {
  matched: true,
  kind: 'checkout',
  subscriptionId: null,
  externalUserId: 'sp:1',
  period: 'P4W',
  method: 1,
  origin: 'manual_renewal',
  amount: 5000,
  currency: 0,
  cycles: 3,
};

const next = new Date('2026-04-09T00:00:00Z');

describe('events for a multi-cycle payment', () => {
  it('report the total charged, the time bought and the cycle count', () => {
    for (const built of [
      initialPaymentSucceeded(event, match, 'sub_1', next).payload,
      recurringPaymentSucceeded(event, match, 'sub_1', next).payload,
      initialPaymentFailed(event, match).payload,
      recurringPaymentFailed(event, match).payload,
      paymentCreated(event, match, 'sub_1').payload,
    ]) {
      expect(built).toMatchObject({ amount: 15000, period: 'P12W', cycles: 3 });
    }
  });

  it('a one-cycle pick on a page selling cycles reports cycles: 1', () => {
    const one = { ...match, cycles: 1 };
    expect(
      recurringPaymentSucceeded({ ...event, amount: 5000 }, one, 'sub_1', next)
        .payload,
    ).toMatchObject({ amount: 5000, period: 'P4W', cycles: 1 });
  });

  it('any other charge reports exactly what it did before: no cycles field', () => {
    const withoutCycles: Match = { ...match };
    Reflect.deleteProperty(withoutCycles, 'cycles');
    for (const plain of [{ ...match, cycles: null }, withoutCycles]) {
      const payload = initialPaymentSucceeded(
        { ...event, amount: 5000 },
        plain,
        'sub_1',
        next,
      ).payload;
      expect(payload).toEqual({
        amount: 5000,
        currency: 0,
        method: 1,
        period: 'P4W',
        source: 'whitepay_callback',
        nextPaymentDate: next.toISOString(),
      });
    }
  });
});
