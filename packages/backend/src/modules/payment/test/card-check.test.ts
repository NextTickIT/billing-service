import { describe, expect, it } from '@effect/vitest';
import { PaymentMethod, PaymentStatus } from '@billing-service/shared';

import type { DeferTarget } from '@/modules/payment/data-access.js';
import {
  type ApplyPaymentParams,
  handoverDecision,
  periodAnchors,
  wholeDaysBetween,
} from '@/modules/payment/domain.js';

const PAID_AT = new Date('2026-11-16T10:00:00Z');
const STARTS_AT = new Date('2026-12-01T00:00:00Z');

const params = (
  over: Partial<ApplyPaymentParams> = {},
): ApplyPaymentParams => ({
  externalUserId: 'sp:cc',
  amount: 5000,
  currency: 1,
  method: PaymentMethod.Card,
  period: 'P4W',
  recurring: true,
  recurringTokenRef: 'tok',
  paidAt: PAID_AT,
  startsAt: STARTS_AT,
  ...over,
});

describe('periodAnchors: a card check bought no period', () => {
  it('runs from the verify to startsAt, where the first charge falls', () => {
    const anchors = periodAnchors(params({ firstCharge: 'card_check' }));

    expect(anchors).toEqual({
      currentPeriodStart: PAID_AT,
      currentPeriodEnd: STARTS_AT,
      nextPaymentDate: STARTS_AT,
    });
  });

  it('a full-price checkout with the same startsAt still buys its period from it', () => {
    const expectedEnd = new Date('2026-12-29T00:00:00Z');

    const anchors = periodAnchors(params({ firstCharge: 'now' }));

    expect(anchors).toEqual({
      currentPeriodStart: STARTS_AT,
      currentPeriodEnd: expectedEnd,
      nextPaymentDate: expectedEnd,
    });
  });
});

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-11-16T10:00:00Z').getTime();
const CURRENT = new Date('2026-12-01T00:00:00Z');

const target = (over: Partial<DeferTarget> = {}): DeferTarget => ({
  status: PaymentStatus.Active,
  firstCharge: 'card_check',
  nextPaymentDate: CURRENT,
  deferRevision: 0,
  charged: false,
  ...over,
});

const at = (offsetMs: number): Date => new Date(CURRENT.getTime() + offsetMs);

describe('handoverDecision: the handover defer shape (plan §1.5)', () => {
  it.each([
    ['exactly the current date', at(0), 'unchanged'],
    ['just before the current date', at(-1), 'unchanged'],
    ['just after the current date', at(1), 'defer'],
    ['exactly the step bound (+30 d)', at(30 * DAY), 'defer'],
    ['just past the step bound (+30 d + 1 ms)', at(30 * DAY + 1), 'refuse'],
  ])('deferTo %s → %s', (_label, deferTo, expected) => {
    const decision = handoverDecision(target(), deferTo, NOW);

    expect(decision.kind).toBe(expected);
  });

  it.each([
    ['exactly now + 62 d', 0, 'defer'],
    ['just past now + 62 d', 1, 'refuse'],
  ])('deferTo %s (inside the step bound) → %s', (_label, past, expected) => {
    const horizon = NOW + 62 * DAY;
    const nearHorizon = target({ nextPaymentDate: new Date(horizon - DAY) });

    const decision = handoverDecision(
      nearHorizon,
      new Date(horizon + past),
      NOW,
    );

    expect(decision.kind).toBe(expected);
  });
});

describe('handoverDecision: what the handover defer refuses', () => {
  it.each([
    ['a full-price payment', target({ firstCharge: 'now' }), 'not_card_check'],
    [
      'a card-check payment that took money',
      target({ charged: true }),
      'charged',
    ],
    [
      'a past-due payment',
      target({ status: PaymentStatus.PastDue }),
      'not_active',
    ],
    [
      'a cancelled payment',
      target({ status: PaymentStatus.Cancelled }),
      'not_active',
    ],
  ])('%s is refused (%s)', (_label, refused, expectedCode) => {
    const decision = handoverDecision(refused, at(DAY), NOW);

    expect(decision).toMatchObject({ kind: 'refuse', code: expectedCode });
  });

  it('a refused not-active payment names its status', () => {
    const decision = handoverDecision(
      target({ status: PaymentStatus.RenewalFailed }),
      at(DAY),
      NOW,
    );

    expect(decision).toMatchObject({
      code: 'not_active',
      paymentStatus: PaymentStatus.RenewalFailed,
    });
  });

  it('an ineligible payment is refused even for a date not after its current one', () => {
    const decision = handoverDecision(
      target({ firstCharge: 'now' }),
      at(0),
      NOW,
    );

    expect(decision.kind).toBe('refuse');
  });
});

describe('wholeDaysBetween: the days a handover defer reports', () => {
  it.each([
    ['just under one day', 24 * 3_600_000 - 1, 0],
    ['exactly one day', 24 * 3_600_000, 1],
    ['three days and an hour', 3 * 24 * 3_600_000 + 3_600_000, 3],
  ])('%s → %d', (_label, gap, expected) => {
    const from = new Date('2026-12-01T00:00:00Z');

    const days = wholeDaysBetween(from, new Date(from.getTime() + gap));

    expect(days).toBe(expected);
  });
});
