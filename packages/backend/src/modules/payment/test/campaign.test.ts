import { describe, expect, test } from 'vitest';

import type { CampaignPayment } from '@/modules/payment/data-access.js';
import { campaignDays, campaignDecision } from '@/modules/payment/domain.js';

const CONTACT = '69ce580b666434807700269f';
const BUYER = '0b6c1f7e-5d1a-4c3e-9a51-2f0e8d6b7c11';
const PERIOD_END = new Date('2027-04-21T10:00:00Z');
const ANSWER = {
  result: 'extended' as const,
  paymentId: 'pay_sub',
  periodEnd: PERIOD_END,
  nextPaymentDate: PERIOD_END,
  nextPaymentDate_formatted: '21.04.2027',
};

const purchase = (over: Partial<CampaignPayment> = {}): CampaignPayment => ({
  id: 'pay_bf',
  recurring: true,
  currentPeriodEnd: new Date('2027-04-28T10:00:00Z'),
  nextPaymentDate: new Date('2027-04-28T10:00:00Z'),
  metadata: { campaign: 'bf2026', offer: 'bf5', extend_days: '154' },
  applied: null,
  ...over,
});

const appliedTo = (externalUserId: string) => ({
  buyerId: BUYER,
  externalUserId,
  ...ANSWER,
});

describe('campaignDays', () => {
  test.each([
    ['the short offer as a string', '154', 154],
    ['the long offer as a number', 364, 364],
    ['the lower bound', '1', 1],
    ['the upper bound', 400, 400],
    ['zero', '0', null],
    ['just over the upper bound', '401', null],
    ['a fraction', 1.5, null],
    ['a negative string', '-5', null],
    ['a decimal string', '15.5', null],
    ['an empty string', '', null],
    ['a non-number', true, null],
  ])('%s', (_name, extendDays, expected) => {
    expect(campaignDays({ extend_days: extendDays })).toBe(expected);
  });

  test('absent metadata adds no days', () => {
    expect(campaignDays(null)).toBeNull();
  });
});

describe('campaignDecision', () => {
  test('no purchase under the buyer id is not found', () => {
    expect(campaignDecision([], CONTACT)).toEqual({ kind: 'not_found' });
  });

  test('an unapplied purchase is applied with its days', () => {
    const row = purchase();

    expect(campaignDecision([row], CONTACT)).toEqual({
      kind: 'apply',
      pending: [row],
      days: 154,
    });
  });

  test('two unapplied purchases are applied together, their days summed', () => {
    const rows = [
      purchase({ id: 'a' }),
      purchase({ id: 'b', metadata: { campaign: 'bf2026', extend_days: 364 } }),
    ];

    expect(campaignDecision(rows, CONTACT)).toMatchObject({
      kind: 'apply',
      days: 518,
    });
  });

  test('a purchase applied to the same contact replays its answer', () => {
    expect(
      campaignDecision([purchase({ applied: appliedTo(CONTACT) })], CONTACT),
    ).toEqual({ kind: 'replay', answer: ANSWER });
  });

  test('a one-time purchase is refused as not recurring', () => {
    expect(campaignDecision([purchase({ recurring: false })], CONTACT)).toEqual(
      { kind: 'not_recurring' },
    );
  });

  test('a purchase applied to the same contact beside a pending one applies only the pending one', () => {
    const pending = purchase({ id: 'b' });

    expect(
      campaignDecision(
        [purchase({ id: 'a', applied: appliedTo(CONTACT) }), pending],
        CONTACT,
      ),
    ).toEqual({ kind: 'apply', pending: [pending], days: 154 });
  });

  test('a purchase applied to another contact refuses the call', () => {
    expect(
      campaignDecision(
        [purchase({ id: 'a', applied: appliedTo('another') }), purchase()],
        CONTACT,
      ),
    ).toEqual({ kind: 'applied_elsewhere' });
  });

  test('a purchase without valid extend_days refuses the call', () => {
    expect(
      campaignDecision(
        [purchase({ metadata: { campaign: 'bf2026', extend_days: '0' } })],
        CONTACT,
      ),
    ).toEqual({ kind: 'invalid_days' });
  });
});
