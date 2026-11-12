import {
  type CreatePayment,
  type Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';

import type {
  ExtendPayment,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import { createOrExtend, periodAnchors } from '@/modules/payment/domain.js';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const params = {
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  recurring: true,
  recurringTokenRef: 'tok',
  paidAt: d('2026-03-10'),
};

describe('periodAnchors with startsAt', () => {
  it('a startsAt in the future anchors the period there, not at the payment', () => {
    expect(periodAnchors({ ...params, startsAt: d('2026-03-25') })).toEqual({
      currentPeriodStart: d('2026-03-25'),
      currentPeriodEnd: d('2026-04-25'),
      nextPaymentDate: d('2026-04-25'),
    });
  });

  it('a startsAt equal to the payment time anchors at the payment', () => {
    expect(periodAnchors({ ...params, startsAt: d('2026-03-10') })).toEqual({
      currentPeriodStart: d('2026-03-10'),
      currentPeriodEnd: d('2026-04-10'),
      nextPaymentDate: d('2026-04-10'),
    });
  });

  it('a startsAt already past when the payment settles never backdates the period', () => {
    expect(periodAnchors({ ...params, startsAt: d('2026-03-01') })).toEqual({
      currentPeriodStart: d('2026-03-10'),
      currentPeriodEnd: d('2026-04-10'),
      nextPaymentDate: d('2026-04-10'),
    });
  });

  it('no startsAt anchors at the payment, as before', () => {
    expect(periodAnchors({ ...params, startsAt: null })).toEqual(
      periodAnchors(params),
    );
    expect(periodAnchors(params).currentPeriodStart).toEqual(d('2026-03-10'));
  });

  it('a promo bonus lands after the paid period that starts at startsAt', () => {
    expect(
      periodAnchors({
        ...params,
        startsAt: d('2026-03-25'),
        promoBonus: 'P7D',
      }),
    ).toEqual({
      currentPeriodStart: d('2026-03-25'),
      currentPeriodEnd: d('2026-05-02'),
      nextPaymentDate: d('2026-05-02'),
    });
  });

  it('several cycles run from startsAt as one duration', () => {
    expect(
      periodAnchors({ ...params, startsAt: d('2026-03-25'), cycles: 3 }),
    ).toEqual({
      currentPeriodStart: d('2026-03-25'),
      currentPeriodEnd: d('2026-06-25'),
      nextPaymentDate: d('2026-06-25'),
    });
  });
});

const liveRow: Payment = {
  id: 'sub_live',
  externalUserId: 'sp:1',
  amount: 30000,
  currency: 0,
  method: 0,
  period: 'P1M',
  status: PaymentStatus.Active,
  recurring: true,
  currentPeriodStart: d('2026-02-20'),
  currentPeriodEnd: d('2026-03-20'),
  nextPaymentDate: d('2026-03-20'),
  recurringTokenRef: 'tok',
  firstFailureAt: null,
  retryAttempt: 0,
  cancelRequestedAt: null,
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** Records the anchors `createOrExtend` writes, through insert or extend. */
const recordingRepo = (existing: Payment | null) => {
  const written: Pick<
    Payment,
    'currentPeriodStart' | 'currentPeriodEnd' | 'nextPaymentDate'
  >[] = [];
  const found = () =>
    Effect.succeed(existing === null ? Option.none() : Option.some(existing));
  const repo = {
    findActiveRecurringByExternalUser: found,
    lockById: found,
    insert: (input: CreatePayment) =>
      Effect.sync(() => {
        written.push(input);
        return { ...input, id: 'sub_new', cancelRequestedAt: null };
      }),
    extend: (_id: string, input: ExtendPayment) =>
      Effect.sync(() => {
        written.push(input);
      }),
  } as unknown as PaymentRepo;
  return { repo, written };
};

describe('createOrExtend with startsAt', () => {
  it('a fresh subscription is anchored at startsAt', () => {
    const { repo, written } = recordingRepo(null);

    const result = Effect.runSync(
      createOrExtend(repo)({ ...params, startsAt: d('2026-03-25') }),
    );

    expect(result.created).toBe(true);
    expect(result.periodStart).toEqual(d('2026-03-25'));
    expect(written[0]?.currentPeriodStart).toEqual(d('2026-03-25'));
    expect(written[0]?.nextPaymentDate).toEqual(d('2026-04-25'));
  });

  it('a payment that stacks onto a live sub ignores startsAt', () => {
    const { repo, written } = recordingRepo(liveRow);

    const result = Effect.runSync(
      createOrExtend(repo)({ ...params, startsAt: d('2026-04-15') }),
    );

    expect(result.prolonged).toBe(true);
    expect(written[0]).toMatchObject({
      currentPeriodStart: d('2026-02-20'),
      currentPeriodEnd: d('2026-04-20'),
      nextPaymentDate: d('2026-04-20'),
    });
  });
});
