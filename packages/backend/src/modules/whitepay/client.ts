import { type Currency, CurrencyCode } from '@billing-service/shared';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import { RateLimiterService, type RateLimiter } from '@/infra/rate-limiter.js';
import { WhitePayConfig } from '@/modules/whitepay/config.js';
import {
  OrderEnvelopeSchema,
  WhitePayOrderSchema,
} from '@/modules/whitepay/contracts.js';
import {
  WhitePayResponseError,
  WhitePayTransportError,
  type WhitePayError,
} from '@/modules/whitepay/errors.js';

/**
 * WhitePay client (docs/17/22). One outbound call: create a fiat-denominated crypto
 * order and hand back its hosted `acquiring_url`. Bearer-authenticated (a static API
 * token, NOT per-request HMAC like WayForPay). The payer picks coin+network on the
 * hosted page — we send neither (docs/23). There is no charge-with-token endpoint to
 * mirror the W4P scheduler: WhitePay cannot bill unattended (the make-or-break finding).
 */
export interface WhitePayClient {
  readonly createOrder: (
    params: CreateOrderParams,
  ) => Effect.Effect<CreatedOrder, WhitePayError>;
}

export interface CreateOrderParams {
  readonly amount: number; // integer minor units (our internal representation)
  readonly currency: Currency;
  /** Our checkout session id → WhitePay `external_order_id` (the match key). */
  readonly externalOrderId: string;
}

export interface CreatedOrder {
  readonly id: string;
  readonly acquiringUrl: string;
  readonly status: string;
}

export class WhitePay extends Context.Tag('WhitePay')<
  WhitePay,
  WhitePayClient
>() {}

/** The slice of `fetch` the client needs — injected so tests need no network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface WhitePayClientOptions {
  readonly slug: string;
  readonly apiToken: string;
  readonly apiUrl: string;
  readonly successfulLink: string;
  readonly failureLink: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

const isTransientWhitePay = (
  error: WhitePayTransportError | WhitePayResponseError,
): boolean =>
  error._tag === 'WhitePayTransportError' &&
  (error.status === undefined || isTransientStatus(error.status));

/**
 * POST JSON with the Bearer header and parse the body as JSON; transport + parse
 * errors are typed. Transient transport failures (network, 429, 5xx) retry with
 * backoff; parse failures do not. Every call is rate-limited (docs/03 Capacity).
 */
const postJson = (
  ctx: WhitePayClientOptions,
  url: string,
  endpoint: string,
  payload: unknown,
): Effect.Effect<unknown, WhitePayTransportError | WhitePayResponseError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await ctx.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ctx.apiToken}`,
          },
          body: JSON.stringify(payload),
          signal,
        });
        return { ok: res.ok, status: res.status, raw: await res.text() };
      },
      catch: (cause) => new WhitePayTransportError({ endpoint, cause }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new WhitePayTransportError({
          endpoint,
          status: response.status,
          body: response.raw,
        }),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(response.raw) as unknown,
      catch: () =>
        new WhitePayResponseError({
          endpoint,
          message: 'invalid JSON in response',
          value: response.raw,
        }),
    });
  }).pipe((effect) =>
    ctx.rateLimiter.limit(retryTransient(effect, isTransientWhitePay)),
  );

/** The create-order body is fiat-only (docs/23): amount in MAJOR units, currency an
 * ISO ticker, our session id as `external_order_id`. No coin/network — the payer picks. */
const orderRequestBody = (
  ctx: WhitePayClientOptions,
  params: CreateOrderParams,
) => ({
  amount: params.amount / 100,
  currency: CurrencyCode[params.currency],
  external_order_id: params.externalOrderId,
  successful_link: ctx.successfulLink.replace(
    '{sessionId}',
    params.externalOrderId,
  ),
  failure_link: ctx.failureLink.replace('{sessionId}', params.externalOrderId),
});

/** Both create-order and webhook bodies may wrap the order under `order` or send it
 * flat; tolerate both, then decode the order boundary permissively (docs/17). */
export const extractOrder = (
  raw: unknown,
): Effect.Effect<
  Schema.Schema.Type<typeof WhitePayOrderSchema>,
  WhitePayResponseError
> =>
  Schema.decodeUnknown(OrderEnvelopeSchema, { onExcessProperty: 'preserve' })(
    raw,
  ).pipe(
    Effect.flatMap((env) =>
      Schema.decodeUnknown(WhitePayOrderSchema, {
        onExcessProperty: 'preserve',
      })(env.order ?? raw),
    ),
    Effect.mapError(
      (error) =>
        new WhitePayResponseError({
          endpoint: 'CREATE_ORDER',
          message: error.message,
          value: raw,
        }),
    ),
  );

const createOrder =
  (ctx: WhitePayClientOptions): WhitePayClient['createOrder'] =>
  (params) =>
    Effect.gen(function* () {
      const url = `${ctx.apiUrl}/private-api/crypto-orders/${ctx.slug}`;
      const body = yield* postJson(
        ctx,
        url,
        'CREATE_ORDER',
        orderRequestBody(ctx, params),
      );
      const order = yield* extractOrder(body);
      if (
        order.id === undefined ||
        order.acquiring_url === undefined ||
        order.acquiring_url.length === 0
      ) {
        return yield* Effect.fail(
          new WhitePayResponseError({
            endpoint: 'CREATE_ORDER',
            message: 'order missing id or acquiring_url',
            value: order,
          }),
        );
      }
      return {
        id: order.id,
        acquiringUrl: order.acquiring_url,
        status: order.status ?? 'INIT',
      };
    });

export const makeWhitePayClient = (
  options: WhitePayClientOptions,
): WhitePayClient => ({
  createOrder: createOrder(options),
});

export const WhitePayLive = Layer.effect(
  WhitePay,
  Effect.gen(function* () {
    const config = yield* WhitePayConfig;
    const rateLimiter = yield* RateLimiterService;
    return makeWhitePayClient({
      slug: config.slug,
      apiToken: Redacted.value(config.apiToken),
      apiUrl: config.apiUrl,
      successfulLink: config.successfulLink,
      failureLink: config.failureLink,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    });
  }),
);
