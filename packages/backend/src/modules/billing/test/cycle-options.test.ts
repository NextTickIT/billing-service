import { type Payment, PaymentStatus } from '@billing-service/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@/config.js';
import { paymentManualRequired } from '@/modules/billing/events.js';

const KEY = 'MANUAL_RENEWAL_CYCLE_OPTIONS';
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, KEY);
  } else {
    process.env[KEY] = saved;
  }
});

const cyclesFrom = (raw: string | undefined): readonly number[] => {
  if (raw === undefined) {
    Reflect.deleteProperty(process.env, KEY);
  } else {
    process.env[KEY] = raw;
  }
  return loadConfig().scheduler.manualRenewalCycleOptions;
};

describe('MANUAL_RENEWAL_CYCLE_OPTIONS', () => {
  it('defaults to the single cycle', () => {
    expect(cyclesFrom(undefined)).toEqual([1]);
  });

  it('parses a list, keeping its order', () => {
    expect(cyclesFrom('1,3,6')).toEqual([1, 3, 6]);
    expect(cyclesFrom(' 3, 1 ')).toEqual([3, 1]);
  });

  it.each([
    ['without 1', '3,6'],
    ['with a duplicate', '1,3,3'],
    ['with a zero', '0,1'],
    ['with a fraction', '1,1.5'],
    ['with junk', '1,three'],
    ['with an empty entry', '1,,3'],
    ['empty', ''],
  ])('fails the boot %s', (_label, raw) => {
    expect(() => cyclesFrom(raw)).toThrow(KEY);
  });
});

const sub: Payment = {
  id: 'sub_1',
  externalUserId: 'sp:1',
  amount: 5000,
  currency: 0,
  method: 1,
  period: 'P4W',
  status: PaymentStatus.PastDue,
  recurring: true,
  currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-01-29T00:00:00Z'),
  nextPaymentDate: new Date('2026-01-29T00:00:00Z'),
  recurringTokenRef: null,
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

it('payment_manual_required carries the cycle counts the link offers', () => {
  const event = paymentManualRequired(
    sub,
    {
      checkoutUrl: 'https://bill.example/checkout/chk_1',
      windowExpiresAt: new Date('2026-02-05T00:00:00Z'),
      cycleOptions: [1, 3, 6],
    },
    new Date('2026-01-29T00:00:00Z'),
    { attempt: 0, nextRetryDate: new Date('2026-01-30T00:00:00Z') },
  );
  expect(event.payload.cycleOptions).toEqual([1, 3, 6]);
  // The prompt still states one cycle's price; the page prices the others.
  expect(event.payload.amount).toBe(5000);
});

describe('PAY_NOW_CLAIM_GRACE_SECONDS', () => {
  const GRACE_KEY = 'PAY_NOW_CLAIM_GRACE_SECONDS';
  const savedGrace = process.env[GRACE_KEY];

  afterEach(() => {
    if (savedGrace === undefined) {
      Reflect.deleteProperty(process.env, GRACE_KEY);
    } else {
      process.env[GRACE_KEY] = savedGrace;
    }
  });

  const graceFrom = (raw: string | undefined): number => {
    if (raw === undefined) {
      Reflect.deleteProperty(process.env, GRACE_KEY);
    } else {
      process.env[GRACE_KEY] = raw;
    }
    return loadConfig().scheduler.payNowClaimGraceSeconds;
  };

  it('defaults to an hour', () => {
    expect(graceFrom(undefined)).toBe(3600);
  });

  it('allows 0, which turns the guard off', () => {
    expect(graceFrom('0')).toBe(0);
  });

  it('parses a value', () => {
    expect(graceFrom('900')).toBe(900);
  });

  it.each([
    ['negative', '-1'],
    ['not a number', 'abc'],
  ])('fails the boot when %s', (_label, raw) => {
    expect(() => graceFrom(raw)).toThrow(GRACE_KEY);
  });
});
