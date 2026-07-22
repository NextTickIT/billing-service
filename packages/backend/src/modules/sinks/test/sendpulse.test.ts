import { it } from '@effect/vitest';
import type { StoredEvent } from '@billing-service/shared';
import { Effect } from 'effect';
import { expect } from 'vitest';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import {
  type FetchLike,
  makeSendPulseConnector,
} from '@/modules/sinks/sendpulse.js';

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

interface Recorded {
  readonly url: string;
  readonly body: unknown;
}

const recordingFetch =
  (status: number, responseBody: unknown, calls: Recorded[]): FetchLike =>
  (url, init) => {
    calls.push({
      url,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(responseBody)),
    });
  };

const event = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: 'evt_1',
  name: 'initial_payment_succeeded',
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  correlationId: 'c1',
  externalUserId: 'contact_9',
  aggregateId: 'pay_1',
  payload: { amount: 5000, currency: 1 },
  ...over,
});

const connectorFor = (fetch: FetchLike, flows: Record<string, string>) =>
  makeSendPulseConnector(
    {
      token: 'sp_apikey_x',
      apiUrl: 'http://sp/telegram',
      fetch,
      rateLimiter: noLimit,
    },
    flows,
  );

it.effect(
  'runs the mapped flow with contact_id + payload as external_data',
  () => {
    const calls: Recorded[] = [];
    return connectorFor(
      recordingFetch(200, { success: true, data: [] }, calls),
      {
        initial_payment_succeeded: 'flow_42',
      },
    )
      .deliver(event())
      .pipe(
        Effect.map(() => {
          expect(calls).toHaveLength(1);
          expect(calls[0]?.url).toBe('http://sp/telegram/flows/run');
          const body = calls[0]?.body as {
            contact_id: string;
            flow_id: string;
            external_data: Record<string, unknown>;
          };
          expect(body.contact_id).toBe('contact_9');
          expect(body.flow_id).toBe('flow_42');
          expect(body.external_data['amount']).toBe(5000);
          expect(body.external_data['event']).toBe('initial_payment_succeeded');
          expect(body.external_data['event_id']).toBe('evt_1');
        }),
      );
  },
);

it.effect('skips an event with no externalUserId (no call)', () => {
  const calls: Recorded[] = [];
  return connectorFor(recordingFetch(200, { success: true }, calls), {
    initial_payment_succeeded: 'flow_42',
  })
    .deliver(
      event({ externalUserId: null, name: 'unknown_payment_quarantined' }),
    )
    .pipe(
      Effect.map(() => {
        expect(calls).toHaveLength(0);
      }),
    );
});

it.effect('skips an unmapped event (no call)', () => {
  const calls: Recorded[] = [];
  return connectorFor(recordingFetch(200, { success: true }, calls), {})
    .deliver(event())
    .pipe(
      Effect.map(() => {
        expect(calls).toHaveLength(0);
      }),
    );
});

it.effect('fails SinkError on a non-transient error response (HTTP 400)', () =>
  connectorFor(recordingFetch(400, { success: false }, []), {
    initial_payment_succeeded: 'flow_42',
  })
    .deliver(event())
    .pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe('SinkError');
      }),
    ),
);

it.effect('fails SinkError when the body is success:false', () =>
  connectorFor(recordingFetch(200, { success: false }, []), {
    initial_payment_succeeded: 'flow_42',
  })
    .deliver(event())
    .pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error._tag).toBe('SinkError');
      }),
    ),
);
