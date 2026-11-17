import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@effect/vitest';
import {
  type CheckoutSession,
  CheckoutSessionKind,
  CheckoutSessionStatus,
  type DomainEvent,
  PaymentMethod,
  type StoredEvent,
} from '@billing-service/shared';

import type { Charge } from '@/modules/charge/contracts.js';
import { recurringPaymentSucceeded } from '@/modules/charge/domain.js';
import {
  cardCheckAnomaly,
  cardCheckEvidence,
  cardCheckFailed,
  cardCheckPaymentCreated,
  subscriptionCardChecked,
} from '@/modules/checkout/card-check.js';
import { paymentDeferred } from '@/modules/payment/cancel.js';
import { crmBody } from '@/modules/sinks/crm.js';

/**
 * The shared wire fixtures (plan §6): the CRM body of each new card-check event, of a
 * handover `payment_deferred` and of a first-charge success, built here by the production
 * builders and `crmBody`. The guildmaster contract tests and the analytics decoder tests
 * carry byte-identical copies of these files, so a change that moves the wire breaks here
 * first.
 */
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../../shared/test/fixtures/wire/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );

const stored = (event: DomainEvent): StoredEvent => ({
  ...event,
  idempotencyKey: event.idempotencyKey ?? event.id,
  payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>,
});

const SESSION_ID = 'chk_0b5e6a3c-1f2d-4c7b-9a8e-1234567890ab';
const PAYMENT_ID = '3f6c2a10-5b7e-4d2a-9c1e-7a8b9c0d1e2f';
const CONTACT = '64f0c0ffee00000000abcd12';
const METADATA = { source: 'wfp_migration', attemptId: 'att_42' };
const VERIFIED_AT = new Date('2026-11-16T10:00:00.000Z');
const STARTS_AT = new Date('2026-12-03T00:00:00.000Z');

const session: CheckoutSession = {
  id: SESSION_ID,
  externalUserId: CONTACT,
  amount: 5000,
  currency: 1,
  period: 'P4W',
  method: PaymentMethod.Card,
  status: CheckoutSessionStatus.Pending,
  kind: CheckoutSessionKind.Checkout,
  recurring: true,
  paymentId: null,
  successUrl: null,
  failureUrl: null,
  promo: null,
  idempotencyKey: null,
  email: '',
  metadata: METADATA,
  expiresAt: STARTS_AT,
  createdAt: VERIFIED_AT,
  renewal: null,
  origin: 'migration',
  renewalOf: null,
  options: null,
  startsAt: STARTS_AT,
  payableUntil: null,
  lockMethod: true,
  firstCharge: 'card_check',
  closedReason: null,
};

const callback = (transactionStatus: string): Charge => ({
  source: 'wayforpay_callback',
  idemKey: `w4pcb:${SESSION_ID}|${transactionStatus}`,
  externalRef: SESSION_ID,
  externalUserId: null,
  amount: 0,
  currency: 0,
  status: 'pending',
  occurredAt: VERIFIED_AT,
  payload: {
    orderReference: SESSION_ID,
    transactionStatus,
    reasonCode: 1100,
    amount: '0',
    currency: 'UAH',
    recToken: 'tok_secret',
  },
});

const verify = callback('WaitingAuthComplete');

const activated = {
  subscriptionId: PAYMENT_ID,
  created: true,
  prolonged: false,
  nextPaymentDate: STARTS_AT,
  periodStart: VERIFIED_AT,
  periodEnd: STARTS_AT,
  metadata: METADATA,
  nextAmount: 5000,
};

const DUE_MS = STARTS_AT.getTime();
const scheduledCharge: Charge = {
  source: 'wayforpay_charge',
  idemKey: `w4p:sub_${PAYMENT_ID}_${DUE_MS.toString()}|CHARGE|1796256000`,
  externalRef: `sub_${PAYMENT_ID}_${DUE_MS.toString()}`,
  externalUserId: CONTACT,
  amount: 5000,
  currency: 1,
  status: 'succeeded',
  occurredAt: STARTS_AT,
  payload: {},
};

const PAID_THROUGH = new Date('2026-12-31T00:00:00.000Z');

const FIXTURES: readonly (readonly [string, DomainEvent])[] = [
  [
    'subscription_card_checked',
    subscriptionCardChecked(verify, session, activated),
  ],
  [
    'payment_created_card_check',
    cardCheckPaymentCreated(verify, session, PAYMENT_ID),
  ],
  ['card_check_failed', cardCheckFailed(verify, session, 'late')],
  [
    'card_check_anomaly',
    cardCheckAnomaly(
      callback('Approved'),
      session,
      cardCheckEvidence(callback('Approved')),
    ),
  ],
  [
    'payment_deferred_handover',
    paymentDeferred(
      {
        paymentId: PAYMENT_ID,
        externalUserId: CONTACT,
        newPeriodEnd: '2026-12-04T00:00:00.000Z',
        days: 1,
        at: VERIFIED_AT.getTime(),
        reason: 'handover',
        revision: 2,
      },
      VERIFIED_AT,
    ),
  ],
  [
    'recurring_payment_succeeded_card_check_first_charge',
    recurringPaymentSucceeded(
      scheduledCharge,
      {
        matched: true,
        kind: 'recurring',
        subscriptionId: PAYMENT_ID,
        externalUserId: CONTACT,
        period: 'P4W',
        method: PaymentMethod.Card,
      },
      PAYMENT_ID,
      {
        nextPaymentDate: PAID_THROUGH,
        periodStart: STARTS_AT,
        periodEnd: PAID_THROUGH,
        metadata: METADATA,
        nextAmount: 5000,
        cardCheckFirstCharge: true,
      },
    ),
  ],
];

describe('the shared wire fixtures are what billing posts to the CRM', () => {
  it.each(FIXTURES)('%s', (name, event) => {
    const body = crmBody(stored(event));

    expect(body).toEqual(fixture(name));
  });

  it('the anomaly reports that a token came, never the token itself', () => {
    const body = JSON.stringify(
      crmBody(
        stored(
          cardCheckAnomaly(
            callback('Approved'),
            session,
            cardCheckEvidence(callback('Approved')),
          ),
        ),
      ),
    );

    expect(body).not.toContain('tok_secret');
  });
});
