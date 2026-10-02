import { describe, expect, test } from 'vitest';

import { DomainEvent } from '@billing-service/shared';

import {
  DATE_FIELDS,
  PERIOD_FIELDS,
  formattedFields,
} from '@/modules/sinks/formatted.js';

describe('dates render as DD.MM.YYYY in Kyiv', () => {
  test('formats each known date field', () => {
    expect(
      formattedFields({ nextPaymentDate: '2026-10-02T09:00:00.000Z' }),
    ).toEqual({ nextPaymentDate_formatted: '02.10.2026' });
  });

  test('uses Kyiv, not UTC — a late-evening charge is the NEXT day locally', () => {
    // 21:30 UTC is 00:30 Kyiv the following day. Naming the wrong day in a "we charge
    // you tomorrow" message is the whole reason the zone is pinned.
    expect(formattedFields({ chargeDate: '2026-10-02T21:30:00.000Z' })).toEqual(
      {
        chargeDate_formatted: '03.10.2026',
      },
    );
  });

  test('pads single digits', () => {
    expect(formattedFields({ dueDate: '2026-01-05T12:00:00.000Z' })).toEqual({
      dueDate_formatted: '05.01.2026',
    });
  });

  test.each([...DATE_FIELDS])('%s is covered', (field) => {
    expect(formattedFields({ [field]: '2026-03-09T10:00:00.000Z' })).toEqual({
      [`${field}_formatted`]: '09.03.2026',
    });
  });
});

describe('periods render in Russian with correct plurals', () => {
  test.each([
    ['P1M', '1 месяц'],
    ['P2M', '2 месяца'],
    ['P4M', '4 месяца'],
    ['P5M', '5 месяцев'],
    ['P1W', '1 неделя'],
    ['P2W', '2 недели'],
    ['P4W', '4 недели'],
    ['P5W', '5 недель'],
    ['P1Y', '1 год'],
    ['P30D', '30 дней'],
  ])('%s -> %s', (period, expected) => {
    expect(formattedFields({ period })).toEqual({
      period_formatted: expected,
    });
  });
});

describe('renders nothing rather than something wrong', () => {
  test('a one-time purchase carries nextPaymentDate: null — no twin', () => {
    expect(formattedFields({ nextPaymentDate: null })).toEqual({});
  });

  test('the P0D one-time sentinel is omitted, never shown to a customer', () => {
    expect(formattedFields({ period: 'P0D' })).toEqual({});
  });

  test('an unparseable date is omitted rather than rendered "Invalid Date"', () => {
    expect(formattedFields({ dueDate: 'not-a-date' })).toEqual({});
  });

  test('leaves unrelated fields alone', () => {
    expect(
      formattedFields({
        amount: 5000,
        currency: 1,
        reason: 'Insufficient funds',
      }),
    ).toEqual({});
  });

  test('a field that merely looks date-ish is not formatted', () => {
    // `source` and `reason` are free text; sniffing would eventually mangle one.
    expect(
      formattedFields({ source: '2026-10-02', reason: '2026-10-02' }),
    ).toEqual({});
  });
});

/**
 * Every payload key in the event union, read off the schemas themselves.
 *
 * The previous version of this guard was a hand-written list of date fields, and its
 * comment claimed it was "what stops a new event shipping to SendPulse without its
 * formatted twin". It could not: a new field absent from both the list and
 * `DATE_FIELDS` matched nothing and the test passed. `periodStart`/`periodEnd` shipped
 * through exactly that gap. This version enumerates the real contract, so a key cannot
 * exist without someone having classified it.
 */
const payloadKeys = (): readonly string[] => {
  const keys = new Set<string>();
  for (const member of DomainEvent.members) {
    const payload = member.fields.payload as { fields?: object };
    for (const key of Object.keys(payload.fields ?? {})) keys.add(key);
  }
  return [...keys].sort();
};

/**
 * Payload keys that deliberately get NO formatted twin, each with the reason.
 *
 * Adding a key here is the explicit act of saying "a customer never reads this
 * rendered". A new payload field matches neither set and fails the test below until
 * it is either given a twin or listed here on purpose.
 */
const NOT_RENDERED: ReadonlyMap<string, string> = new Map([
  ['amount', 'minor units; the flow formats money with its own currency rules'],
  ['currency', 'numeric code, branched on rather than shown'],
  ['method', 'numeric; the flow writes its own wording for card vs crypto'],
  ['attempt', 'a number the flow branches on to escalate wording'],
  ['noticeDays', 'the offset that fired this notice, not customer-facing'],
  ['days', 'granted free days; the flow phrases its own sentence'],
  ['movedPayments', 'operational count, never messaged'],
  ['movedSessions', 'operational count, never messaged'],
  ['recurring', 'boolean the flow branches on'],
  ['source', 'provider label, internal'],
  ['reason', 'provider decline text, passed through verbatim'],
  ['paymentId', 'opaque id'],
  ['quarantineId', 'opaque id'],
  ['incomingEventId', 'opaque id'],
  ['externalRef', 'provider order reference'],
  ['from', 'an external user id, not prose'],
  ['to', 'an external user id, not prose'],
  ['checkoutUrl', 'a link, used as-is'],
  ['metadata', "the caller's opaque object; we promise to echo it unchanged"],
]);

// Without this, a walk that silently returned nothing would make the check below pass
// vacuously — the exact failure mode of the list it replaced.

describe('drift guard', () => {
  test('the walk actually reads the schemas', () => {
    const keys = payloadKeys();
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('periodEnd');
    expect(keys).toContain('metadata');
  });

  test('every payload key is classified as rendered or deliberately not', () => {
    const unclassified = payloadKeys().filter(
      (k) =>
        !DATE_FIELDS.has(k) && !PERIOD_FIELDS.has(k) && !NOT_RENDERED.has(k),
    );
    expect(unclassified).toEqual([]);
  });

  test.each([...DATE_FIELDS])(
    'date field %s produces a formatted twin',
    (field) => {
      const out = formattedFields({ [field]: '2026-12-31T00:00:00.000Z' });
      expect(Object.keys(out)).toEqual([`${field}_formatted`]);
    },
  );

  test('a key listed as not-rendered produces no twin', () => {
    for (const key of NOT_RENDERED.keys()) {
      expect(formattedFields({ [key]: '2026-12-31T00:00:00.000Z' })).toEqual(
        {},
      );
    }
  });
});
