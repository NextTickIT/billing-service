import { describe, expect, it } from '@effect/vitest';
import {
  CHARGE_KINDS,
  EVENT_NAMES,
  type StoredEvent,
} from '@billing-service/shared';
import { Duration, Effect, Fiber, TestClock } from 'effect';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import {
  type CrmClient,
  crmBody,
  makeCrmConnector,
} from '@/modules/sinks/crm.js';
import type { FetchLike } from '@/modules/sinks/sendpulse.js';
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
      chargeKind: 'checkout',
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
      charge_kind: 'checkout',
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
      chargeKind: 'scheduled',
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
      charge_kind: 'scheduled',
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
      chargeKind: 'checkout',
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
      charge_kind: 'checkout',
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

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

const deadlineMillis = 10_000;

interface Posted {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** The CRM's side of one POST: what it answers, or a transport failure. */
type Answer =
  | { readonly status: number; readonly body: string }
  | { readonly networkError: Error };

/** A CRM endpoint that records every POST and gives the same answer to each. */
const crmAnswering = (answer: Answer) => {
  const posts: Posted[] = [];
  const fetch: FetchLike = (url, init) => {
    posts.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return 'networkError' in answer
      ? Promise.reject(answer.networkError)
      : Promise.resolve({
          ok: answer.status >= 200 && answer.status < 300,
          status: answer.status,
          text: () => Promise.resolve(answer.body),
        });
  };
  return { posts, fetch };
};

const ack = (schemaStatus: string): Answer => ({
  status: 200,
  body: JSON.stringify({
    status: 'ok',
    event_id: 'crm_evt_1',
    schema_status: schemaStatus,
  }),
});

const client = (
  fetch: FetchLike,
  over: Partial<CrmClient> = {},
): CrmClient => ({
  token: 'crm-token',
  url: 'https://crm.example/api/public/v1/events',
  fetch,
  rateLimiter: noLimit,
  timeoutMillis: deadlineMillis,
  ...over,
});

/**
 * Deliver once. The delivery runs in a fiber while the test clock is moved a minute on, so
 * a connector that slept — an in-call backoff, a deadline — settles instead of hanging.
 */
const deliver = (crm: CrmClient, e: StoredEvent) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      Effect.either(makeCrmConnector(crm).deliver(e)),
    );
    yield* TestClock.adjust('1 minute');
    return yield* Fiber.join(fiber);
  });

const DELIVERED = { _tag: 'Right' };
const PERMANENT = { _tag: 'Left', left: { sink: 'crm', permanent: true } };
const RETRYABLE = { _tag: 'Left', left: { sink: 'crm', permanent: false } };

describe('makeCrmConnector — what the CRM stored', () => {
  // The success kinds move money; the CRM acts on them only once they are `validated`, so
  // anything else would be acknowledged and never paid. Every other kind is delivered
  // unless the CRM rejected it.
  it.effect.each([
    ['initial_payment_succeeded', 'validated', DELIVERED],
    ['initial_payment_succeeded', 'unregistered', PERMANENT],
    ['initial_payment_succeeded', 'rejected', PERMANENT],
    ['recurring_payment_succeeded', 'validated', DELIVERED],
    ['recurring_payment_succeeded', 'unregistered', PERMANENT],
    ['recurring_payment_succeeded', 'rejected', PERMANENT],
    ['one_time_purchase_succeeded', 'validated', DELIVERED],
    ['one_time_purchase_succeeded', 'unregistered', PERMANENT],
    ['one_time_purchase_succeeded', 'rejected', PERMANENT],
    ['renewal_failed', 'validated', DELIVERED],
    ['renewal_failed', 'unregistered', DELIVERED],
    ['renewal_failed', 'rejected', PERMANENT],
    ['upcoming_charge', 'validated', DELIVERED],
    ['upcoming_charge', 'unregistered', DELIVERED],
    ['upcoming_charge', 'rejected', PERMANENT],
  ] as const)('%s stored %s → %o', ([name, schemaStatus, expected]) =>
    Effect.gen(function* () {
      const crm = crmAnswering(ack(schemaStatus));

      const result = yield* deliver(client(crm.fetch), event({ name }));

      expect(result).toMatchObject(expected);
      expect(crm.posts).toHaveLength(1);
    }),
  );

  it.effect('a refusal names the kind and how the CRM stored it', () =>
    Effect.gen(function* () {
      const crm = crmAnswering(ack('rejected'));

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          reason:
            'crm stored recurring_payment_succeeded as rejected (event crm_evt_1)',
        },
      });
    }),
  );
});

describe('makeCrmConnector — an unreadable 2xx', () => {
  // Nothing in such a body says whether the CRM kept the event, so it is asked again
  // later (it dedupes on `id`) — by the queue, not in a tight loop.
  it.effect.each([
    ['an HTML proxy page', '<html>502 Bad Gateway</html>'],
    ['an empty body', ''],
    ['JSON without schema_status', '{"status":"ok","event_id":"crm_evt_1"}'],
    [
      'an unknown schema_status',
      '{"status":"ok","event_id":"crm_evt_1","schema_status":"queued"}',
    ],
    [
      'a status other than ok',
      '{"status":"error","event_id":"crm_evt_1","schema_status":"validated"}',
    ],
  ] as const)('%s is a retryable failure', ([, body]) =>
    Effect.gen(function* () {
      const crm = crmAnswering({ status: 200, body });

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject(RETRYABLE);
      expect(crm.posts).toHaveLength(1);
    }),
  );
});

describe('makeCrmConnector — HTTP status', () => {
  it.effect.each([
    ['400', 400],
    ['403 (a token without the money_events scope)', 403],
    ['404', 404],
    ['422 (a rejected money-kind payload)', 422],
  ] as const)('%s is permanent, posted once', ([, status]) =>
    Effect.gen(function* () {
      const crm = crmAnswering({ status, body: '{"error":"x"}' });

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject(PERMANENT);
      expect(crm.posts).toHaveLength(1);
    }),
  );

  it.effect.each([
    ['401 (a token the operator has not fixed yet)', 401],
    ['408 (a request timeout: send it again)', 408],
  ] as const)('%s is retryable on the queue, posted once', ([, status]) =>
    Effect.gen(function* () {
      const crm = crmAnswering({ status, body: '{"error":"x"}' });

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject(RETRYABLE);
      expect(crm.posts).toHaveLength(1);
    }),
  );

  it.effect.each([
    ['500', 500],
    ['503', 503],
    ['429', 429],
  ] as const)(
    // One bounded POST per delivery attempt: retrying inside the call held the single
    // dispatcher, and every delivery behind it, for about a minute per message.
    '%s is left to the queue, posted once',
    ([, status]) =>
      Effect.gen(function* () {
        const crm = crmAnswering({ status, body: '' });

        const result = yield* deliver(client(crm.fetch), event());

        expect(result).toMatchObject(RETRYABLE);
        expect(crm.posts).toHaveLength(1);
      }),
  );

  it.effect('a network error is left to the queue, posted once', () =>
    Effect.gen(function* () {
      const crm = crmAnswering({
        networkError: new TypeError('fetch failed'),
      });

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject(RETRYABLE);
      expect(crm.posts).toHaveLength(1);
    }),
  );
});

describe('makeCrmConnector — an enabled sink missing its config', () => {
  // A delivery that waits for the operator, never a silent success: the event is still
  // owed to the CRM.
  it.effect.each([
    ['no url', { url: '' }, 'crm sink enabled without url'],
    ['no token', { token: '' }, 'crm sink enabled without token'],
    ['neither', { url: '', token: '' }, 'crm sink enabled without url, token'],
  ] as const)(
    '%s fails retryably and posts nothing',
    ([, over, expectedReason]) =>
      Effect.gen(function* () {
        const crm = crmAnswering(ack('validated'));

        const result = yield* deliver(client(crm.fetch, over), event());

        expect(result).toMatchObject({
          _tag: 'Left',
          left: { permanent: false, reason: expectedReason },
        });
        expect(crm.posts).toHaveLength(0);
      }),
  );
});

describe('makeCrmConnector — the request', () => {
  it.effect(
    'POSTs the envelope to the configured url with the three headers',
    () =>
      Effect.gen(function* () {
        const crm = crmAnswering(ack('validated'));
        const e = event({ idempotencyKey: 'idem_evt_k1' });

        yield* deliver(client(crm.fetch), e);

        expect(crm.posts).toHaveLength(1);
        expect(crm.posts[0]).toMatchObject({
          url: 'https://crm.example/api/public/v1/events',
          method: 'POST',
          body: { id: 'evt_k1:succeeded', name: 'recurring_payment_succeeded' },
        });
        expect(crm.posts[0]?.headers).toEqual({
          'Content-Type': 'application/json',
          Authorization: 'Bearer crm-token',
          'Idempotency-Key': 'idem_evt_k1',
        });
      }),
  );
});

/** A promise that settles only when `signal` aborts — a peer that went quiet. */
const stalled = <A>(signal: AbortSignal | undefined): Promise<A> =>
  new Promise<A>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/** A CRM that accepts the POST and then goes quiet at `where`. */
const crmStalling = (where: 'headers' | 'body') => {
  let posts = 0;
  const fetch: FetchLike = (_url, init) => {
    posts += 1;
    return where === 'headers'
      ? stalled(init.signal)
      : Promise.resolve({
          ok: true,
          status: 200,
          text: () => stalled<string>(init.signal),
        });
  };
  return { fetch, posts: () => posts };
};

/** A CRM whose `validated` answer is held until the test releases it. */
const crmHeld = () => {
  let release: () => void = () => undefined;
  const fetch: FetchLike = () =>
    new Promise((resolve) => {
      release = () => {
        resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              '{"status":"ok","event_id":"crm_evt_1","schema_status":"validated"}',
            ),
        });
      };
    });
  return {
    fetch,
    release: () => {
      release();
    },
  };
};

describe('makeCrmConnector — the deadline', () => {
  // The dispatcher runs one message at a time; a CRM that stops answering must cost one
  // deadline per queue attempt, not hold every delivery behind it.
  it.effect.each([
    ['no headers ever arrive', 'headers'],
    ['headers arrive and the body stalls', 'body'],
  ] as const)('%s → retryable timeout, posted once', ([, where]) =>
    Effect.gen(function* () {
      const crm = crmStalling(where);

      const result = yield* deliver(client(crm.fetch), event());

      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          permanent: false,
          reason: 'crm POST timed out after 10000ms',
        },
      });
      expect(crm.posts()).toBe(1);
    }),
  );

  it.effect('an answer one millisecond before the deadline is delivered', () =>
    Effect.gen(function* () {
      const crm = crmHeld();
      const fiber = yield* Effect.fork(
        Effect.either(makeCrmConnector(client(crm.fetch)).deliver(event())),
      );
      yield* TestClock.adjust(Duration.millis(deadlineMillis - 1));

      crm.release();
      const result = yield* Fiber.join(fiber);

      expect(result).toMatchObject(DELIVERED);
    }),
  );

  it.effect('an answer held until the deadline is a timeout', () =>
    Effect.gen(function* () {
      const crm = crmHeld();
      const fiber = yield* Effect.fork(
        Effect.either(makeCrmConnector(client(crm.fetch)).deliver(event())),
      );
      yield* TestClock.adjust(Duration.millis(deadlineMillis));

      crm.release();
      const result = yield* Fiber.join(fiber);

      expect(result).toMatchObject(RETRYABLE);
    }),
  );
});

// The CRM registry (guildmaster c8bd978d) accepts exactly these two values; any other is
// stored `rejected`, which this connector dead-letters for every success kind. The union
// is pinned here so a new value cannot ship before the CRM accepts it.
const expectedCrmChargeKinds = ['scheduled', 'checkout'];

describe('charge_kind', () => {
  it('has exactly the values the CRM registry accepts', () => {
    expect([...CHARGE_KINDS].sort()).toEqual(
      [...expectedCrmChargeKinds].sort(),
    );
  });
});
