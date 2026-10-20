import { EVENT_NAMES, type StoredEvent } from '@billing-service/shared';
import { describe, expect, it } from 'vitest';

import { crmBody } from '@/modules/sinks/crm.js';
import { snakeCaseKeys, toSnakeCase } from '@/modules/sinks/snake-case.js';

const event = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: 'evt_k1:succeeded',
  idempotencyKey: 'evt_k1:succeeded',
  name: 'recurring_payment_succeeded',
  occurredAt: new Date('2026-03-01T10:30:00Z'),
  correlationId: 'k1',
  externalUserId: 'sp:42',
  aggregateId: 'pay_1',
  payload: {
    amount: 30000,
    currency: 0,
    nextPaymentDate: '2026-04-01T00:00:00.000Z',
    periodStart: '2026-03-01T00:00:00.000Z',
    metadata: null,
  },
  ...over,
});

describe('toSnakeCase', () => {
  it('renames at a camel boundary', () => {
    expect(toSnakeCase('externalUserId')).toBe('external_user_id');
    expect(toSnakeCase('periodStart')).toBe('period_start');
  });

  it('leaves a key that is already snake_case alone', () => {
    expect(toSnakeCase('next_payment_date')).toBe('next_payment_date');
    expect(toSnakeCase('amount')).toBe('amount');
  });

  it('keeps an acronym together instead of exploding it', () => {
    expect(toSnakeCase('orderURL')).toBe('order_url');
    expect(toSnakeCase('URLTarget')).toBe('url_target');
  });

  it('splits a trailing digit run', () => {
    expect(toSnakeCase('dueDate2')).toBe('due_date_2');
  });
});

describe('snakeCaseKeys', () => {
  it('recurses through nested objects and arrays', () => {
    expect(
      snakeCaseKeys({
        topLevel: { innerKey: [{ deepOne: 1 }] },
      }),
    ).toEqual({ top_level: { inner_key: [{ deep_one: 1 }] } });
  });

  it('leaves non-object leaves untouched', () => {
    expect(snakeCaseKeys({ aKey: null, bKey: 0, cKey: 'camelValue' })).toEqual({
      a_key: null,
      b_key: 0,
      // Only KEYS are renamed. A value is data, and rewriting it would corrupt it.
      c_key: 'camelValue',
    });
  });

  // The whole point of the exemption: `metadata` is the caller's own object, echoed back
  // unchanged by promise. A caller who sends `utmSource` must read `utmSource` back.
  it('does NOT rename keys inside metadata', () => {
    expect(
      snakeCaseKeys({
        externalUserId: 'sp:1',
        metadata: { utmSource: 'tg', nested: { campaignId: 7 } },
      }),
    ).toEqual({
      external_user_id: 'sp:1',
      metadata: { utmSource: 'tg', nested: { campaignId: 7 } },
    });
  });
});

const SUBSCRIPTION = 'pay_1';
const CORRELATION = 'wp:order-1|Approved';

/** One row per event kind billing emits: the stored payload, and the wire payload the CRM
 * must receive — the two subject fields first, then the payload's own keys, snake_cased. */
const KINDS: readonly (readonly [
  StoredEvent['name'],
  Record<string, unknown>,
  Record<string, unknown>,
])[] = [
  [
    'initial_payment_succeeded',
    {
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      source: 'wayforpay_callback',
      nextPaymentDate: '2026-04-01T00:00:00.000Z',
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
      recurring: true,
      metadata: null,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      source: 'wayforpay_callback',
      next_payment_date: '2026-04-01T00:00:00.000Z',
      period_start: '2026-03-01T00:00:00.000Z',
      period_end: '2026-04-01T00:00:00.000Z',
      recurring: true,
      metadata: null,
    },
  ],
  [
    'recurring_payment_succeeded',
    {
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      source: 'wayforpay_charge',
      nextPaymentDate: '2026-05-01T00:00:00.000Z',
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
      recurring: true,
      metadata: null,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      source: 'wayforpay_charge',
      next_payment_date: '2026-05-01T00:00:00.000Z',
      period_start: '2026-04-01T00:00:00.000Z',
      period_end: '2026-05-01T00:00:00.000Z',
      recurring: true,
      metadata: null,
    },
  ],
  [
    'one_time_purchase_succeeded',
    {
      amount: 90000,
      currency: 0,
      method: 0,
      period: 'P3M',
      source: 'wayforpay_callback',
      nextPaymentDate: null,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-06-01T00:00:00.000Z',
      recurring: false,
      metadata: null,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 90000,
      currency: 0,
      method: 0,
      period: 'P3M',
      source: 'wayforpay_callback',
      next_payment_date: null,
      period_start: '2026-03-01T00:00:00.000Z',
      period_end: '2026-06-01T00:00:00.000Z',
      recurring: false,
      metadata: null,
    },
  ],
  [
    'initial_payment_failed',
    {
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      reason: 'Declined',
      source: 'wayforpay_callback',
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      reason: 'Declined',
      source: 'wayforpay_callback',
    },
  ],
  [
    'recurring_payment_failed',
    {
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      reason: 'Declined',
      source: 'wayforpay_callback',
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      reason: 'Declined',
      source: 'wayforpay_callback',
    },
  ],
  [
    'payment_created',
    {
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      renewal: { amount: 5000, period: 'P4W' },
      metadata: null,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      renewal: { amount: 5000, period: 'P4W' },
      metadata: null,
    },
  ],
  [
    'charge_retry_failed',
    {
      attempt: 2,
      nextRetryDate: '2026-03-04T00:00:00.000Z',
      reason: 'Insufficient funds',
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      attempt: 2,
      next_retry_date: '2026-03-04T00:00:00.000Z',
      reason: 'Insufficient funds',
    },
  ],
  [
    'renewal_failed',
    { reason: 'retries_exhausted' },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      reason: 'retries_exhausted',
    },
  ],
  [
    'payment_manual_required',
    {
      amount: 4900,
      currency: 1,
      method: 1,
      paymentId: 'pay_1',
      checkoutUrl: 'https://pay.example.test/c/chk_1',
      dueDate: '2026-03-01T00:00:00.000Z',
      windowExpiresAt: '2026-03-04T00:00:00.000Z',
      attempt: 1,
      nextRetryDate: '2026-03-02T00:00:00.000Z',
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      amount: 4900,
      currency: 1,
      method: 1,
      payment_id: 'pay_1',
      checkout_url: 'https://pay.example.test/c/chk_1',
      due_date: '2026-03-01T00:00:00.000Z',
      window_expires_at: '2026-03-04T00:00:00.000Z',
      attempt: 1,
      next_retry_date: '2026-03-02T00:00:00.000Z',
    },
  ],
  [
    'upcoming_charge',
    {
      paymentId: 'pay_1',
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      chargeDate: '2026-03-08T00:00:00.000Z',
      noticeDays: 7,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      payment_id: 'pay_1',
      amount: 150000,
      currency: 0,
      method: 0,
      period: 'P1M',
      charge_date: '2026-03-08T00:00:00.000Z',
      notice_days: 7,
    },
  ],
  [
    'payment_cancelled',
    { reason: 'operator' },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      reason: 'operator',
    },
  ],
  [
    'payment_reactivated',
    {},
    { aggregate_id: SUBSCRIPTION, correlation_id: CORRELATION },
  ],
  [
    'payment_deferred',
    { newPeriodEnd: '2026-04-08T00:00:00.000Z', days: 7 },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      new_period_end: '2026-04-08T00:00:00.000Z',
      days: 7,
    },
  ],
  [
    'method_changed',
    { method: 1 },
    { aggregate_id: SUBSCRIPTION, correlation_id: CORRELATION, method: 1 },
  ],
  [
    'external_user_id_changed',
    { from: 'sp:41', to: 'sp:42', movedPayments: 3, movedSessions: 1 },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      from: 'sp:41',
      to: 'sp:42',
      moved_payments: 3,
      moved_sessions: 1,
    },
  ],
  [
    'card_change_succeeded',
    { method: 0 },
    { aggregate_id: SUBSCRIPTION, correlation_id: CORRELATION, method: 0 },
  ],
  [
    'card_change_failed',
    { reason: 'Declined' },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      reason: 'Declined',
    },
  ],
  [
    'unknown_payment_quarantined',
    {
      quarantineId: 'q_1',
      incomingEventId: 'in_1',
      source: 'whitepay_callback',
      externalRef: 'order-2',
      amount: 4900,
      currency: 1,
    },
    {
      aggregate_id: SUBSCRIPTION,
      correlation_id: CORRELATION,
      quarantine_id: 'q_1',
      incoming_event_id: 'in_1',
      source: 'whitepay_callback',
      external_ref: 'order-2',
      amount: 4900,
      currency: 1,
    },
  ],
];

describe('crmBody', () => {
  // The CRM keeps `id, name, occurred_at, external_user_id, payload` and dedupes on `id`;
  // its registry requires `aggregate_id` and `correlation_id` inside every billing
  // payload. The top-level copies and `idempotency_key` ride along for other readers.
  it.each(KINDS)(
    'posts %s with the subject fields inside the payload and the envelope on top',
    (name, payload, expectedPayload) => {
      const body = crmBody(
        event({
          name,
          correlationId: CORRELATION,
          aggregateId: SUBSCRIPTION,
          payload,
        }),
      );

      expect(body).toEqual({
        id: 'evt_k1:succeeded',
        idempotency_key: 'evt_k1:succeeded',
        name,
        occurred_at: '2026-03-01T10:30:00.000Z',
        external_user_id: 'sp:42',
        correlation_id: CORRELATION,
        aggregate_id: SUBSCRIPTION,
        payload: expectedPayload,
      });
    },
  );

  it('covers every event kind billing emits', () => {
    expect(KINDS.map(([name]) => name).sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('never adds the SendPulse *_formatted twins', () => {
    const body = crmBody(event()) as { payload: Record<string, unknown> };
    // Those exist so a flow can drop a value into a Russian sentence. The CRM renders its
    // own UI from the canonical instant, and a pre-rendered date would be wrong for it.
    expect(
      Object.keys(body.payload).some((k) => k.endsWith('_formatted')),
    ).toBe(false);
  });

  it('passes a caller metadata object through verbatim', () => {
    const body = crmBody(
      event({
        payload: { amount: 1, metadata: { planCode: 'half_year', tier: 2 } },
      }),
    ) as { payload: { metadata: unknown } };
    expect(body.payload.metadata).toEqual({ planCode: 'half_year', tier: 2 });
  });

  it('carries a null externalUserId (a quarantine event has no contact)', () => {
    const body = crmBody(event({ externalUserId: null })) as {
      external_user_id: unknown;
    };
    expect(body.external_user_id).toBe(null);
  });
});
