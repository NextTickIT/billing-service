import { describe, expect, it } from '@effect/vitest';
import { CheckoutSessionStatus } from '@billing-service/shared';

import type { Charge } from '@/modules/charge/contracts.js';
import {
  type CardCheckFacts,
  cardCheckEvidence,
  classifyCardCheck,
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
