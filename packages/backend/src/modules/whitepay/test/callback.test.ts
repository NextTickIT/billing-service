import { Currency } from '@billing-service/shared';
import { describe, expect, test } from 'vitest';

import {
  hmacSha256Hex,
  normalizeWebhook,
  verifyWebhook,
} from '@/modules/whitepay/callback.js';

const token = 'whsec_test';

const order = {
  id: 'ord_9',
  status: 'COMPLETE',
  external_order_id: 'chk_1',
  value: '10.10',
  currency: 'USD',
  received_total: '10.10',
  completed_at: '2026-01-02T03:04:05Z',
};

const rawBody = JSON.stringify({ order });

describe('verifyWebhook', () => {
  test('accepts a correct HMAC-SHA256 Signature over the raw body', () => {
    const signature = hmacSha256Hex(rawBody, token);
    expect(verifyWebhook(token, rawBody, signature, undefined)).toBe(true);
  });

  test('rejects a tampered Signature', () => {
    expect(verifyWebhook(token, rawBody, 'deadbeef', undefined)).toBe(false);
  });

  test('rejects when the raw body differs (re-serialization trap)', () => {
    const signature = hmacSha256Hex(rawBody, token);
    const reserialized = JSON.stringify({ order: { ...order } }) + ' ';
    expect(verifyWebhook(token, reserialized, signature, undefined)).toBe(
      false,
    );
  });

  test('accepts the X-Secret-Key shared-secret mode', () => {
    expect(verifyWebhook(token, rawBody, undefined, token)).toBe(true);
    expect(verifyWebhook(token, rawBody, undefined, 'wrong')).toBe(false);
  });

  test('an empty webhook token never verifies (dark deploy rejects callbacks)', () => {
    expect(verifyWebhook('', rawBody, hmacSha256Hex(rawBody, ''), '')).toBe(
      false,
    );
  });
});

describe('normalizeWebhook', () => {
  test('maps a COMPLETE order into a succeeded charge keyed on external_order_id', () => {
    const event = normalizeWebhook({ order });
    expect(event.source).toBe('whitepay_callback');
    expect(event.externalRef).toBe('chk_1');
    expect(event.idemKey).toBe('wp:ord_9|COMPLETE');
    expect(event.amount).toBe(1010);
    expect(event.currency).toBe(Currency.USD);
    expect(event.status).toBe('succeeded');
    expect(event.externalUserId).toBeNull();
    expect(event.occurredAt.getTime()).toBe(Date.parse('2026-01-02T03:04:05Z'));
  });

  test('tolerates a flat order (no `order` envelope)', () => {
    const event = normalizeWebhook(order);
    expect(event.externalRef).toBe('chk_1');
    expect(event.status).toBe('succeeded');
  });

  test('a DECLINED order is a failed charge; the raw payload is retained', () => {
    const event = normalizeWebhook({
      order: { ...order, status: 'DECLINED' },
    });
    expect(event.status).toBe('failed');
    expect(event.idemKey).toBe('wp:ord_9|DECLINED');
    expect(event.payload['order']).toBeDefined();
  });

  test('a non-object payload degrades to an empty, unknown charge (never throws)', () => {
    const event = normalizeWebhook(null);
    expect(event.externalRef).toBe('');
    expect(event.status).toBe('unknown');
  });
});
