import type { StoredEvent } from '@billing-service/shared';
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

describe('crmBody', () => {
  it('carries the whole envelope, snake_cased', () => {
    expect(crmBody(event())).toEqual({
      id: 'evt_k1:succeeded',
      // The dedupe surface travels as its own field — the CRM collapses a redelivery on
      // this rather than having to know how our ids are shaped.
      idempotency_key: 'evt_k1:succeeded',
      name: 'recurring_payment_succeeded',
      occurred_at: '2026-03-01T10:30:00.000Z',
      correlation_id: 'k1',
      external_user_id: 'sp:42',
      aggregate_id: 'pay_1',
      payload: {
        amount: 30000,
        currency: 0,
        next_payment_date: '2026-04-01T00:00:00.000Z',
        period_start: '2026-03-01T00:00:00.000Z',
        metadata: null,
      },
    });
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
