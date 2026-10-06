import type { StoredEvent } from '@billing-service/shared';
import { Effect, Option, Ref } from 'effect';
import { describe, expect, it } from 'vitest';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import { type CachedToken, makeEmailConnector } from '@/modules/sinks/email.js';
import { renderReceipt } from '@/modules/sinks/receipt.js';
import type { FetchLike } from '@/modules/sinks/sendpulse.js';

const noLimit: RateLimiter = { take: Effect.void, limit: (effect) => effect };

interface Recorded {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

interface Bodies {
  /** Raw `expires_in` as the provider states it — number, string or absent. */
  readonly expiresIn?: unknown;
  /** The send envelope. SendPulse can reject with HTTP 200 and a falsy body. */
  readonly sendBody?: unknown;
  /** Verbatim response text, for a 200 that is not JSON at all (proxy error page). */
  readonly sendRaw?: string;
}

/** Replies 200 to the token call and `sendStatus` to the send call, recording both. */
const fakeFetch =
  (calls: Recorded[], sendStatus = 200, bodies: Bodies = {}): FetchLike =>
  (url, init) => {
    calls.push({
      url,
      body:
        init.body === undefined
          ? undefined
          : (JSON.parse(init.body) as Record<string, unknown>),
    });
    const isToken = url.endsWith('/oauth/access_token');
    const status = isToken ? 200 : sendStatus;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () =>
        Promise.resolve(
          isToken
            ? JSON.stringify({
                access_token: 'tok-1',
                ...('expiresIn' in bodies
                  ? { expires_in: bodies.expiresIn }
                  : { expires_in: 3600 }),
              })
            : status >= 400
              ? // What the real API does on a rejection: it echoes the request back,
                // recipient included. That is why the error text must not carry it.
                JSON.stringify({
                  error: 'rejected',
                  to: (
                    JSON.parse(String(init.body)) as {
                      email: { to: { email: string }[] };
                    }
                  ).email.to,
                })
              : (bodies.sendRaw ??
                JSON.stringify(bodies.sendBody ?? { result: true })),
        ),
    });
  };

const event = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  id: 'evt_1',
  name: 'initial_payment_succeeded',
  occurredAt: new Date('2026-10-02T05:45:15.000Z'),
  correlationId: 'wp:1|COMPLETE',
  externalUserId: 'sp:1',
  aggregateId: 'pay_1',
  payload: {
    amount: 5000,
    currency: 1,
    method: 1,
    period: 'P4W',
    nextPaymentDate: '2026-10-30T05:45:15.000Z',
  },
  ...over,
});

const connector = (
  calls: Recorded[],
  opts: {
    readonly address?: string | null;
    readonly events?: readonly string[];
    readonly sendStatus?: number;
    readonly cache?: Ref.Ref<CachedToken | null>;
    readonly bodies?: Bodies;
  } = {},
) =>
  Effect.gen(function* () {
    const cache = opts.cache ?? (yield* Ref.make<CachedToken | null>(null));
    return {
      cache,
      sink: makeEmailConnector(
        {
          clientId: 'cid',
          clientSecret: 'secret',
          apiUrl: 'https://api.sendpulse.test',
          from: { name: 'NextTick', email: 'no-reply@nexttick.it' },
          replyTo: '',
          fetch: fakeFetch(calls, opts.sendStatus ?? 200, opts.bodies ?? {}),
          rateLimiter: noLimit,
          tokenCache: cache,
          resolveEmail: () =>
            Effect.succeed(
              opts.address === null || opts.address === undefined
                ? Option.none<string>()
                : Option.some(opts.address),
            ),
        },
        opts.events ?? ['initial_payment_succeeded'],
      ),
    };
  });

describe('renderReceipt', () => {
  it('renders the money, the cadence and the next charge date', () => {
    const r = renderReceipt(event());
    expect(r).not.toBeNull();
    expect(r?.html).toContain('50.00 USD');
    // Formatted by the SAME helper the bot messages use, so the two cannot disagree.
    expect(r?.html).toContain('30.10.2026');
    expect(r?.html).toContain('4 недели');
    expect(r?.text).toContain('50.00 USD');
  });

  it('adds a button only when the payment carries a URL', () => {
    const without = renderReceipt(event());
    expect(without?.html).not.toContain('<a href="https://go.test');
    const withUrl = renderReceipt(
      event({
        payload: { amount: 5000, currency: 1, successUrl: 'https://go.test/a' },
      }),
    );
    expect(withUrl?.html).toContain('https://go.test/a');
    expect(withUrl?.html).toContain('Открыть доступ');
  });

  it('points a failure message at the retry URL instead', () => {
    const r = renderReceipt(
      event({
        name: 'payment_manual_required',
        payload: {
          amount: 5000,
          currency: 1,
          manualCheckoutUrl: 'https://pay.test/x',
        },
      }),
    );
    expect(r?.html).toContain('https://pay.test/x');
    expect(r?.html).toContain('Оплатить');
  });

  it('refuses a non-http URL rather than putting it in a mail client', () => {
    const r = renderReceipt(
      event({
        payload: {
          amount: 5000,
          currency: 1,
          successUrl: 'javascript:alert(1)',
        },
      }),
    );
    expect(r?.html).not.toContain('javascript:');
  });

  it('has no copy for an event that is not a receipt', () => {
    expect(renderReceipt(event({ name: 'payment_created' }))).toBeNull();
  });
});

describe('email connector', () => {
  it('sends the receipt, base64-encoded, after minting a token', async () => {
    const calls: Recorded[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, { address: 'a@b.co' });
        yield* sink.deliver(event());
      }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.sendpulse.test/oauth/access_token',
      'https://api.sendpulse.test/smtp/emails',
    ]);
    const sent = calls[1]?.body as { email: Record<string, unknown> };
    expect(sent.email['to']).toEqual([{ email: 'a@b.co' }]);
    const html = Buffer.from(String(sent.email['html']), 'base64').toString(
      'utf8',
    );
    expect(html).toContain('50.00 USD');
    // A text/plain part ships with every send — it measurably helps inbox placement.
    expect(String(sent.email['text'])).toContain('NextTick');
  });

  it('reuses a cached token on the next send', async () => {
    const calls: Recorded[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, { address: 'a@b.co' });
        yield* sink.deliver(event());
        yield* sink.deliver(event({ id: 'evt_2' }));
      }),
    );
    expect(
      calls.filter((c) => c.url.endsWith('/oauth/access_token')),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/smtp/emails'))).toHaveLength(2);
  });
});

describe('email connector token cache', () => {
  const mints = (calls: Recorded[]): number =>
    calls.filter((c) => c.url.endsWith('/oauth/access_token')).length;

  // A TTL at or below the refresh skew used to make the cached token stale the instant
  // it was written, which turned caching off without saying so: one OAuth mint per
  // receipt, against a token endpoint the provider rate-limits.
  it.each([
    ['a string, as some OAuth servers send it', '3600'],
    ['absent entirely', undefined],
    ['shorter than the refresh skew', 30],
  ])(
    'still caches the token when expires_in is %s',
    async (_label, expiresIn) => {
      const calls: Recorded[] = [];
      await Effect.runPromise(
        Effect.gen(function* () {
          const { sink } = yield* connector(calls, {
            address: 'a@b.co',
            bodies: { expiresIn },
          });
          yield* sink.deliver(event());
          yield* sink.deliver(event({ id: 'evt_2' }));
        }),
      );
      expect(mints(calls)).toBe(1);
      expect(calls.filter((c) => c.url.endsWith('/smtp/emails'))).toHaveLength(
        2,
      );
    },
  );

  it('never reuses a token past the expiry the provider stated', async () => {
    const calls: Recorded[] = [];
    const cached = await Effect.runPromise(
      Effect.gen(function* () {
        const { sink, cache } = yield* connector(calls, {
          address: 'a@b.co',
          bodies: { expiresIn: 30 },
        });
        yield* sink.deliver(event());
        return yield* Ref.get(cache);
      }),
    );
    // Stretching the stored expiry instead of shortening the reuse window would hand
    // out a dead token; the 401 that follows is non-transient, so that receipt would
    // hard-fail and dead-letter rather than simply re-minting.
    expect(cached).not.toBeNull();
    if (cached !== null) {
      expect(cached.reuseUntilMillis).toBeLessThan(cached.expiresAtMillis);
    }
  });

  it('sends nothing for an event outside the declared scope', async () => {
    const calls: Recorded[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, {
          address: 'a@b.co',
          events: ['recurring_payment_succeeded'],
        });
        yield* sink.deliver(event());
      }),
    );
    expect(calls).toEqual([]);
  });
});

describe('email connector failure handling', () => {
  it('fails loudly when a payer has no address on file', async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, { address: null });
        yield* sink.deliver(event());
      }),
    );
    expect(exit._tag).toBe('Failure');
    // Not a silent skip: "paid, but we cannot reach them" is the exact failure this
    // channel exists to remove, so it must reach the dead-letter path.
    expect(JSON.stringify(exit)).toContain('no email on file');
    expect(calls).toEqual([]);
  });

  it('drops the cached token on a 401 so the next attempt re-mints', async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink, cache } = yield* connector(calls, {
          address: 'a@b.co',
          sendStatus: 401,
        });
        const result = yield* Effect.exit(sink.deliver(event()));
        const cached = yield* Ref.get(cache);
        return { result, cached };
      }),
    );
    expect(exit._tag).toBe('Success');
    if (exit._tag === 'Success') {
      expect(exit.value.result._tag).toBe('Failure');
      expect(exit.value.cached).toBeNull();
    }
  });
});

describe('email connector provider rejections', () => {
  it.each([
    ['result:false', { result: false }],
    ['is_error:true', { is_error: true, message: 'quota exceeded' }],
  ])(
    'fails on an HTTP 200 the provider rejected with %s',
    async (_label, sendBody) => {
      const calls: Recorded[] = [];
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const { sink } = yield* connector(calls, {
            address: 'a@b.co',
            bodies: { sendBody },
          });
          yield* sink.deliver(event());
        }),
      );
      // Marking this delivered is the one outcome worse than failing: the row says sent,
      // the watchdog stays quiet, and the buyer never gets the receipt.
      expect(exit._tag).toBe('Failure');
      expect(JSON.stringify(exit)).toContain('rejected the send');
    },
  );

  it('leaves a 200 that is not JSON alone rather than re-sending it', async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, {
          address: 'a@b.co',
          // Genuinely unparseable, so the catch is actually reached. The mail may well
          // have gone out; failing here would send it twice on retry.
          bodies: { sendRaw: '<html>502 Bad Gateway</html>' },
        });
        yield* sink.deliver(event());
      }),
    );
    expect(exit._tag).toBe('Success');
  });

  it("keeps the provider's own reason, which is the only text saying why", async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, {
          address: 'a@b.co',
          bodies: { sendBody: { is_error: true, message: 'quota exceeded' } },
        });
        yield* sink.deliver(event());
      }),
    );
    expect(JSON.stringify(exit)).toContain('quota exceeded');
  });
});

describe('email connector stored error text', () => {
  it('keeps the payer address out of the stored error text', async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, {
          address: 'payer@private.co',
          sendStatus: 400,
        });
        yield* sink.deliver(event());
      }),
    );
    // This text is persisted to `event_deliveries."lastError"`; the provider echoes the
    // recipient back on a rejection, and that is the one customer datum we send.
    expect(JSON.stringify(exit)).not.toContain('payer@private.co');
    expect(JSON.stringify(exit)).toContain('HTTP 400');
  });

  it('carries readable text on the error, so a dead delivery says why', async () => {
    const calls: Recorded[] = [];
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { sink } = yield* connector(calls, {
          address: 'a@b.co',
          sendStatus: 422,
        });
        yield* sink.deliver(event());
      }),
    );
    expect(JSON.stringify(exit)).toContain('HTTP 422');
  });
});
