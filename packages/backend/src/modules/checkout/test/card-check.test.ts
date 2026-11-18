import { describe, expect, it } from '@effect/vitest';
import { CheckoutSessionStatus } from '@billing-service/shared';

import type { Charge } from '@/modules/charge/contracts.js';
import {
  type CardCheckFacts,
  cardCheckEvidence,
  classifyCardCheck,
  isProviderRefund,
  rawAmountMinor,
} from '@/modules/checkout/card-check.js';

/** The raw serviceUrl callback of a verified card (live facts, plan §0). */
const verifiedRaw = {
  orderReference: 'chk_cc',
  transactionStatus: 'WaitingAuthComplete',
  reasonCode: 1100,
  amount: '0',
  currency: 'UAH',
  recToken: 'tok_cc',
};

/** A callback charge as the pipeline receives it; the normalised amount/currency are the
 * defaults a missing raw field would produce, so the evidence must not read them. */
const charge = (
  raw: Record<string, unknown>,
  source = 'wayforpay_callback',
): Charge => ({
  source,
  idemKey: 'w4pcb:chk_cc|WaitingAuthComplete',
  externalRef: 'chk_cc',
  externalUserId: null,
  amount: 0,
  currency: 0,
  status: 'pending',
  occurredAt: new Date('2026-11-16T10:00:00Z'),
  payload: raw,
});

const without = (key: keyof typeof verifiedRaw) =>
  Object.fromEntries(Object.entries(verifiedRaw).filter(([k]) => k !== key));

describe('cardCheckEvidence: a verified card, read from the raw callback only', () => {
  it.each([
    ['the live callback (numeric reasonCode)', verifiedRaw],
    ['reasonCode as text', { ...verifiedRaw, reasonCode: '1100' }],
    ['amount "0.00"', { ...verifiedRaw, amount: '0.00' }],
    ['amount as the number 0', { ...verifiedRaw, amount: 0 }],
  ])('%s is verified', (_label, raw) => {
    const evidence = cardCheckEvidence(charge(raw));

    expect(evidence.verified).toBe(true);
  });

  it.each([
    ['a missing amount', without('amount')],
    ['amount "0.01"', { ...verifiedRaw, amount: '0.01' }],
    ['amount as the number 50', { ...verifiedRaw, amount: 50 }],
    ['amount as an array ["0"]', { ...verifiedRaw, amount: ['0'] }],
    ['amount ""', { ...verifiedRaw, amount: '' }],
    ['a missing currency', without('currency')],
    ['currency USD', { ...verifiedRaw, currency: 'USD' }],
    ['status Approved', { ...verifiedRaw, transactionStatus: 'Approved' }],
    ['reasonCode 1101', { ...verifiedRaw, reasonCode: 1101 }],
    ['a missing reasonCode', without('reasonCode')],
    ['an empty recToken', { ...verifiedRaw, recToken: '' }],
    ['a missing recToken', without('recToken')],
  ])('%s is not verified', (_label, raw) => {
    const evidence = cardCheckEvidence(charge(raw));

    expect(evidence.verified).toBe(false);
  });

  it('the same payload from the poller is not verified (only the signed callback is)', () => {
    const evidence = cardCheckEvidence(charge(verifiedRaw, 'wayforpay_poller'));

    expect(evidence.verified).toBe(false);
  });

  it.each([
    ['Declined', true],
    ['Expired', true],
    ['WaitingAuthComplete', false],
    ['Approved', false],
  ])('status %s is a decline: %s', (transactionStatus, expected) => {
    const evidence = cardCheckEvidence(
      charge({ ...verifiedRaw, transactionStatus }),
    );

    expect(evidence.declined).toBe(expected);
  });

  it('reports the raw status, code and whether a token came, never the token', () => {
    const evidence = cardCheckEvidence(
      charge({ ...verifiedRaw, transactionStatus: 'Approved' }),
    );

    expect(evidence).toMatchObject({
      status: 'Approved',
      reasonCode: '1100',
      verified: false,
    });
    expect(evidence.token).toBe('tok_cc');
  });
});

/** The raw serviceUrl callback of an approved 1 USD verify charge (`charge_refund`). */
const chargedRaw = {
  orderReference: 'chk_cc',
  transactionStatus: 'Approved',
  reasonCode: 1100,
  amount: '1',
  currency: 'USD',
  recToken: 'tok_cc',
};

const VERIFY_CHARGE_MINOR = 100;
const CHARGE_REFUND = {
  method: 'charge_refund',
  amountMinor: VERIFY_CHARGE_MINOR,
} as const;

const withoutCharged = (key: keyof typeof chargedRaw) =>
  Object.fromEntries(Object.entries(chargedRaw).filter(([k]) => k !== key));

describe('cardCheckEvidence: a charge_refund verify, read from the raw callback only', () => {
  it.each([
    ['the approved callback, amount "1"', chargedRaw],
    ['amount "1.00"', { ...chargedRaw, amount: '1.00' }],
    ['amount as the number 1', { ...chargedRaw, amount: 1 }],
    ['reasonCode as text', { ...chargedRaw, reasonCode: '1100' }],
  ])('%s is verified', (_label, raw) => {
    const evidence = cardCheckEvidence(charge(raw), CHARGE_REFUND);

    expect(evidence.verified).toBe(true);
  });

  it.each([
    ['just under the verify amount, 0.99', { ...chargedRaw, amount: '0.99' }],
    ['just over the verify amount, 1.01', { ...chargedRaw, amount: '1.01' }],
    ['a sub-cent amount, 1.001', { ...chargedRaw, amount: '1.001' }],
    ['amount 0', { ...chargedRaw, amount: '0' }],
    ['a missing amount', withoutCharged('amount')],
    ['currency UAH', { ...chargedRaw, currency: 'UAH' }],
    ['a missing currency', withoutCharged('currency')],
    [
      'status WaitingAuthComplete (the lookup success)',
      { ...chargedRaw, transactionStatus: 'WaitingAuthComplete' },
    ],
    ['reasonCode 1101', { ...chargedRaw, reasonCode: 1101 }],
    ['a missing recToken', withoutCharged('recToken')],
  ])('%s is not verified', (_label, raw) => {
    const evidence = cardCheckEvidence(charge(raw), CHARGE_REFUND);

    expect(evidence.verified).toBe(false);
  });

  it('the lookup verify payload is not a charge_refund verify', () => {
    const evidence = cardCheckEvidence(charge(verifiedRaw), CHARGE_REFUND);

    expect(evidence.verified).toBe(false);
  });

  it('the approved charge is not a lookup verify', () => {
    const evidence = cardCheckEvidence(charge(chargedRaw));

    expect(evidence.verified).toBe(false);
  });

  it('the same payload from the poller is not verified', () => {
    const evidence = cardCheckEvidence(
      charge(chargedRaw, 'wayforpay_poller'),
      CHARGE_REFUND,
    );

    expect(evidence.verified).toBe(false);
  });
});

describe('cardCheckEvidence: what a charge_refund callback took and declined', () => {
  it.each([
    ['an approved verify charge', chargedRaw, true],
    [
      'an approved charge at the wrong amount',
      { ...chargedRaw, amount: '50' },
      true,
    ],
    ['an approved charge without a token', withoutCharged('recToken'), true],
    [
      'an approved charge from the poller',
      chargedRaw,
      true,
      'wayforpay_poller',
    ],
    [
      'a declined charge',
      { ...chargedRaw, transactionStatus: 'Declined' },
      false,
    ],
    [
      'a charge still in processing',
      { ...chargedRaw, transactionStatus: 'InProcessing' },
      false,
    ],
  ])('%s took money: %s', (_label, raw, expected, source?: string) => {
    const evidence = cardCheckEvidence(charge(raw, source), CHARGE_REFUND);

    expect(evidence.moneyTaken).toBe(expected);
  });

  it('an approved callback on a lookup session took no money to refund', () => {
    const evidence = cardCheckEvidence(charge(chargedRaw));

    expect(evidence.moneyTaken).toBe(false);
  });

  it.each([
    ['Declined', true],
    ['Expired', true],
    ['Approved', false],
  ])('status %s is a decline: %s', (transactionStatus, expected) => {
    const evidence = cardCheckEvidence(
      charge({ ...chargedRaw, transactionStatus }),
      CHARGE_REFUND,
    );

    expect(evidence.declined).toBe(expected);
  });
});

describe('rawAmountMinor: a major-unit decimal as exact minor units', () => {
  it.each([
    ['"1"', '1', 100],
    ['"1.00"', '1.00', 100],
    ['"1.5"', '1.5', 150],
    ['"0.99"', '0.99', 99],
    ['the number 1.01', 1.01, 101],
    ['"0"', '0', 0],
  ])('%s is %d', (_label, raw, expected) => {
    expect(rawAmountMinor(raw)).toBe(expected);
  });

  it.each([
    ['a sub-cent "1.001"', '1.001'],
    ['a negative "-1"', '-1'],
    ['an empty string', ''],
    ['text', 'one'],
    ['absent', undefined],
    ['NaN', Number.NaN],
  ])('%s is unreadable', (_label, raw) => {
    expect(rawAmountMinor(raw)).toBeNull();
  });
});

describe("isProviderRefund: the provider returned an order's money", () => {
  it.each([
    ['a Refunded order', { transactionStatus: 'Refunded' }, 'pending', true],
    ['a Voided order', { transactionStatus: 'Voided' }, 'unknown', true],
    ['a REFUND journal row', { transactionType: 'REFUND' }, 'refunded', true],
    [
      'an Approved charge',
      { transactionStatus: 'Approved' },
      'succeeded',
      false,
    ],
    ['a Declined charge', { transactionStatus: 'Declined' }, 'failed', false],
  ] as const)('%s: %s', (_label, raw, status, expected) => {
    const event = { ...charge(raw), status };

    expect(isProviderRefund(event)).toBe(expected);
  });
});

const HOUR = 3_600_000;
const STARTS_AT = new Date('2026-12-01T00:00:00Z');
const LATE_FROM = STARTS_AT.getTime() - 24 * HOUR;
const VERIFIED = { verified: true, declined: false };

const facts = (over: Partial<CardCheckFacts> = {}): CardCheckFacts => ({
  status: CheckoutSessionStatus.Created,
  evidence: VERIFIED,
  nowMillis: LATE_FROM - 10 * HOUR,
  startsAt: STARTS_AT,
  payableUntil: null,
  ...over,
});

describe('classifyCardCheck: the outcome table (plan §1.3)', () => {
  it.each([
    ['open Created, verified, early', facts(), 'verify'],
    [
      'open Pending, verified, early',
      facts({ status: CheckoutSessionStatus.Pending }),
      'verify',
    ],
    [
      'Closed, verified',
      facts({ status: CheckoutSessionStatus.Closed }),
      'closed',
    ],
    [
      'Closed, declined',
      facts({
        status: CheckoutSessionStatus.Closed,
        evidence: { verified: false, declined: true },
      }),
      'closed',
    ],
    [
      'Expired (never written today), verified',
      facts({ status: CheckoutSessionStatus.Expired }),
      'closed',
    ],
    [
      'Completed, a later verify',
      facts({ status: CheckoutSessionStatus.Completed }),
      'terminal',
    ],
    [
      'Completed, a later decline',
      facts({
        status: CheckoutSessionStatus.Completed,
        evidence: { verified: false, declined: true },
      }),
      'terminal',
    ],
  ])('%s → %s', (_label, input, expected) => {
    const outcome = classifyCardCheck(input);

    expect(outcome).toBe(expected);
  });
});

describe('classifyCardCheck: an open session', () => {
  it.each([
    [
      'open, declined',
      facts({ evidence: { verified: false, declined: true } }),
      'declined',
    ],
    [
      'open, declined even when late',
      facts({
        evidence: { verified: false, declined: true },
        nowMillis: LATE_FROM,
      }),
      'declined',
    ],
    [
      'open, neither verified nor declined',
      facts({ evidence: { verified: false, declined: false } }),
      'anomalous',
    ],
    [
      'open, unverified even when late',
      facts({
        evidence: { verified: false, declined: false },
        nowMillis: LATE_FROM,
      }),
      'anomalous',
    ],
    [
      'open, verified, no startsAt (the create forbids it)',
      facts({ startsAt: null }),
      'late',
    ],
  ])('%s → %s', (_label, input, expected) => {
    const outcome = classifyCardCheck(input);

    expect(outcome).toBe(expected);
  });
});

describe('classifyCardCheck: the late boundaries', () => {
  it.each([
    ['just before startsAt − 24 h', LATE_FROM - 1, 'verify'],
    ['exactly startsAt − 24 h', LATE_FROM, 'late'],
    ['just after startsAt − 24 h', LATE_FROM + 1, 'late'],
  ])('a verify %s → %s', (_label, nowMillis, expected) => {
    const outcome = classifyCardCheck(facts({ nowMillis }));

    expect(outcome).toBe(expected);
  });

  const PAYABLE_UNTIL = new Date(LATE_FROM - 5 * HOUR);

  it.each([
    ['just before payableUntil', PAYABLE_UNTIL.getTime() - 1, 'verify'],
    ['exactly at payableUntil', PAYABLE_UNTIL.getTime(), 'late'],
    ['just after payableUntil', PAYABLE_UNTIL.getTime() + 1, 'late'],
  ])('a verify %s → %s', (_label, nowMillis, expected) => {
    const outcome = classifyCardCheck(
      facts({ nowMillis, payableUntil: PAYABLE_UNTIL }),
    );

    expect(outcome).toBe(expected);
  });
});
