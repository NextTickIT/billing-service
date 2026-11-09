import { type Payment, PaymentStatus } from '@billing-service/shared';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { chargeRetryFailed, withSettlement } from '@/modules/billing/events.js';
import type { Charge } from '@/modules/charge/contracts.js';

const charge: Charge = {
  source: 'wayforpay_charge',
  idemKey: 'w4p:sub_1_1|CHARGE|1700000000',
  externalRef: 'sub_1_1',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  status: 'succeeded',
  occurredAt: new Date('2026-03-01T00:00:00Z'),
  payload: {},
};

describe('withSettlement', () => {
  // Every field distinct, the next charge date included, so reporting one field as
  // another (e.g. the window's end as the next charge) cannot pass. The charged terms are
  // the row the scheduler charged, frozen with the window.
  it('carries the charged terms and each field the advance credited into its own place', () => {
    const settled = withSettlement(
      charge,
      Option.some({
        currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
        nextPaymentDate: new Date('2026-03-04T00:00:00Z'),
        metadata: { planCode: 'half_year' },
        nextAmount: 45000,
      }),
      { period: 'P4W', method: 1 },
    );

    expect(settled.settlement).toEqual({
      period: 'P4W',
      method: 1,
      periodStart: new Date('2026-02-01T00:00:00Z'),
      periodEnd: new Date('2026-03-01T00:00:00Z'),
      nextPaymentDate: new Date('2026-03-04T00:00:00Z'),
      metadata: { planCode: 'half_year' },
      nextAmount: 45000,
    });
  });

  it('leaves the charge without a snapshot when the advance credited nothing', () => {
    const settled = withSettlement(charge, Option.none(), {
      period: 'P4W',
      method: 1,
    });

    expect(settled).toEqual(charge);
  });
});

describe('chargeRetryFailed', () => {
  it('carries the amount, currency and method the retry charges again', () => {
    const payment: Payment = {
      id: 'pay_1',
      externalUserId: 'sp:1',
      amount: 150000,
      currency: 1,
      method: 0,
      period: 'P1M',
      status: PaymentStatus.PastDue,
      recurring: true,
      currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
      nextPaymentDate: new Date('2026-03-01T00:00:00Z'),
      recurringTokenRef: 'tok',
      firstFailureAt: null,
      retryAttempt: 0,
      cancelRequestedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const event = chargeRetryFailed(
      payment,
      {
        attempt: 1,
        nextRetryDate: new Date('2026-03-02T00:00:00Z'),
        reason: 'Insufficient funds',
      },
      new Date('2026-03-01T00:00:00Z'),
    );

    expect(event.payload).toEqual({
      attempt: 1,
      nextRetryDate: '2026-03-02T00:00:00.000Z',
      reason: 'Insufficient funds',
      amount: 150000,
      currency: 1,
      method: 0,
    });
  });
});
