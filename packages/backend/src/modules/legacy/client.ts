import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import { makeRateLimiter, type RateLimiter } from '@/infra/rate-limiter.js';
import { SpConfig } from '@/modules/legacy/config.js';
import {
  type SpError,
  type SpPayment,
  SpPaymentsResponse,
  SpResponseError,
  SpTransportError,
} from '@/modules/legacy/contracts.js';

/**
 * SendPulse CRM read client (docs/25). One endpoint — `GET /crm/v1/payments/all`,
 * which returns the whole payment history in a single call (SendPulse ignores
 * limit/offset there, so there is no pagination). Static Bearer auth; transient
 * failures retry with backoff; every call is rate-limited. Read-only: the import
 * never writes back to SendPulse.
 */
export interface SendPulseClient {
  readonly listPayments: () => Effect.Effect<readonly SpPayment[], SpError>;
}

export class SendPulse extends Context.Tag('SendPulse')<
  SendPulse,
  SendPulseClient
>() {}

/** The slice of `fetch` the client needs — injected so tests need no network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SendPulseClientOptions {
  readonly apiToken: string;
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

const isTransientSp = (error: SpError): boolean =>
  error._tag === 'SpTransportError' &&
  (error.status === undefined || isTransientStatus(error.status));

/**
 * GET a CRM endpoint with Bearer auth and parse JSON; transport + parse errors are
 * typed. Transient transport failures (network, 429, 5xx) retry with backoff; a
 * parse error does not. Every call is rate-limited.
 */
const getJson = (
  ctx: SendPulseClientOptions,
  url: string,
  endpoint: string,
): Effect.Effect<unknown, SpError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await ctx.fetch(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${ctx.apiToken}`,
            'content-type': 'application/json',
          },
          signal,
        });
        return { ok: res.ok, status: res.status, raw: await res.text() };
      },
      catch: (cause) => new SpTransportError({ endpoint, cause }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new SpTransportError({ endpoint, status: response.status }),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(response.raw) as unknown,
      catch: () =>
        new SpResponseError({ endpoint, message: 'invalid JSON in response' }),
    });
  }).pipe((effect) =>
    ctx.rateLimiter.limit(retryTransient(effect, isTransientSp)),
  );

const decode =
  <A, I>(schema: Schema.Schema<A, I>, endpoint: string) =>
  (body: unknown): Effect.Effect<A, SpResponseError> =>
    Schema.decodeUnknown(schema, { onExcessProperty: 'preserve' })(body).pipe(
      Effect.mapError(
        (error) => new SpResponseError({ endpoint, message: error.message }),
      ),
    );

const listPayments =
  (ctx: SendPulseClientOptions): SendPulseClient['listPayments'] =>
  () =>
    Effect.gen(function* () {
      const url = `${ctx.apiUrl}/crm/v1/payments/all`;
      const body = yield* getJson(ctx, url, 'payments/all');
      const parsed = yield* decode(SpPaymentsResponse, 'payments/all')(body);
      return 'data' in parsed ? parsed.data : parsed;
    });

export const makeSendPulseClient = (
  options: SendPulseClientOptions,
): SendPulseClient => ({
  listPayments: listPayments(options),
});

export const SendPulseLive = Layer.effect(
  SendPulse,
  Effect.gen(function* () {
    const config = yield* SpConfig;
    const rateLimiter = yield* makeRateLimiter(config.rateLimitRps);
    return makeSendPulseClient({
      apiToken: Redacted.value(config.apiToken),
      apiUrl: config.apiUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    });
  }),
);
