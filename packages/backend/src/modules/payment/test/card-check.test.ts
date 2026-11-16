import { describe, expect, it } from '@effect/vitest';
import { PaymentMethod, PaymentStatus } from '@billing-service/shared';

import type { DeferTarget } from '@/modules/payment/data-access.js';
import {
  type ApplyPaymentParams,
  handoverDecision,
  operatorDeferBlocked,
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

describe('handoverDecision: a first charge already due may be in flight', () => {
  it.each([
    [
      'due just now (next = now − 1 ms)',
      -1,
      { kind: 'refuse', code: 'charge_in_flight' },
    ],
    ['due exactly now', 0, { kind: 'refuse', code: 'charge_in_flight' }],
    ['due 1 ms from now', 1, { kind: 'defer' }],
  ])('%s → %o', (_label, offset, expected) => {
    const dueAt = target({ nextPaymentDate: new Date(NOW + offset) });

    const decision = handoverDecision(dueAt, new Date(NOW + DAY), NOW);

    expect(decision).toMatchObject(expected);
  });

  it('a charged payment says charged, even when due', () => {
    const decision = handoverDecision(
      target({ charged: true, nextPaymentDate: new Date(NOW - DAY) }),
      new Date(NOW + DAY),
      NOW,
    );

    expect(decision).toMatchObject({ code: 'charged' });
  });
});

describe('operatorDeferBlocked: an operator defer of a due, untaken first charge', () => {
  it.each([
    [
      'a due, untaken card check (next = now)',
      target({ nextPaymentDate: new Date(NOW) }),
      true,
    ],
    [
      'due a millisecond ago',
      target({ nextPaymentDate: new Date(NOW - 1) }),
      true,
    ],
    [
      'not due yet (now + 1 ms)',
      target({ nextPaymentDate: new Date(NOW + 1) }),
      false,
    ],
    [
      'due but already charged',
      target({ nextPaymentDate: new Date(NOW), charged: true }),
      false,
    ],
    [
      'a full-price payment that is due',
      target({ nextPaymentDate: new Date(NOW), firstCharge: 'now' }),
      false,
    ],
  ])('%s → %s', (_label, input, expected) => {
    const blocked = operatorDeferBlocked(input, NOW);

    expect(blocked).toBe(expected);
  });
});

describe('handoverDecision: past a bound', () => {
  it.each([
    ['just past the step bound (+30 d + 1 ms)', target(), at(30 * DAY + 1)],
    [
      'just past now + 62 d',
      target({ nextPaymentDate: new Date(NOW + 61 * DAY) }),
      new Date(NOW + 62 * DAY + 1),
    ],
  ])('%s → out_of_bounds', (_label, input, deferTo) => {
    const decision = handoverDecision(input, deferTo, NOW);

    expect(decision).toMatchObject({ kind: 'refuse', code: 'out_of_bounds' });
  });
});
