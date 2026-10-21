import { Option } from 'effect';
import { describe, expect, it } from 'vitest';

import { withSettlement } from '@/modules/billing/events.js';
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
  // another (e.g. the window's end as the next charge) cannot pass.
  it('carries each field of what the advance credited into its own place', () => {
    const settled = withSettlement(
      charge,
      Option.some({
        currentPeriodStart: new Date('2026-02-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-03-01T00:00:00Z'),
        nextPaymentDate: new Date('2026-03-04T00:00:00Z'),
        metadata: { planCode: 'half_year' },
      }),
    );

    expect(settled.settlement).toEqual({
      periodStart: new Date('2026-02-01T00:00:00Z'),
      periodEnd: new Date('2026-03-01T00:00:00Z'),
      nextPaymentDate: new Date('2026-03-04T00:00:00Z'),
      metadata: { planCode: 'half_year' },
    });
  });

  it('leaves the charge without a snapshot when the advance credited nothing', () => {
    const settled = withSettlement(charge, Option.none());

    expect(settled).toEqual(charge);
  });
});
