import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import { RateLimiterService, type RateLimiter } from '@/infra/rate-limiter.js';
import { W4pConfig } from '@/modules/wayforpay/config.js';
import {
  REASON,
  type W4pCheckStatusResponse,
  W4pCheckStatusResponseSchema,
  type W4pRegularStatusResponse,
  W4pRegularStatusResponseSchema,
  type W4pTransaction,
  W4pTransactionListResponseSchema,
} from '@/modules/wayforpay/contracts.js';
import {
  W4pApiError,
  type W4pError,
  W4pOrderNotFoundError,
  W4pResponseError,
  W4pTransportError,
  W4pWindowTooLargeError,
} from '@/modules/wayforpay/errors.js';
import { signRequest } from '@/modules/wayforpay/signature.js';
import type { DateWindow } from '@/modules/wayforpay/windows.js';

/**
 * WayForPay client — two endpoints with different auth: `/api` signs with
 * HMAC-MD5 over the secret key (TRANSACTION_LIST, CHECK_STATUS); `/regularApi`
 * uses `merchantPassword` unsigned (subscription STATUS). Read-only for now
 * (M3/M4); Purchase/CHARGE land with checkout/scheduler (M5/M6).
 */
export interface WayForPayClient {
  /** TRANSACTION_LIST for one window. 1109 → {@link W4pWindowTooLargeError}. */
  readonly transactionList: (
    window: DateWindow,
  ) => Effect.Effect<readonly W4pTransaction[], W4pError>;
  /** CHECK_STATUS by orderReference. 1127 → {@link W4pOrderNotFoundError}. */
  readonly checkStatus: (
    orderReference: string,
  ) => Effect.Effect<W4pCheckStatusResponse, W4pError>;
  /** regularApi STATUS by original orderReference (reasonCode 4100/4107 = ok). */
  readonly regularStatus: (
    orderReference: string,
  ) => Effect.Effect<W4pRegularStatusResponse, W4pError>;
}

export class WayForPay extends Context.Tag('WayForPay')<
  WayForPay,
  WayForPayClient
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

export interface WayForPayClientOptions {
  readonly merchantAccount: string;
  readonly merchantSecretKey: string;
  readonly merchantPassword: string;
  readonly apiUrl: string;
  readonly regularApiUrl: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

const isTransientW4p = (error: W4pTransportError | W4pResponseError): boolean =>
  error._tag === 'W4pTransportError' &&
  (error.status === undefined || isTransientStatus(error.status));

/** Coerce reasonCode to a number (responses sometimes send it as a string). */
const asReasonCode = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/**
 * POST JSON and parse the body as JSON; transport + parse errors are typed.
 * Transient transport failures (network, 429, 5xx) retry with backoff; parse and
 * business reasonCodes do not. Every call is rate-limited.
 */
const postJson = (
  ctx: WayForPayClientOptions,
  url: string,
  endpoint: string,
  payload: unknown,
): Effect.Effect<unknown, W4pTransportError | W4pResponseError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await ctx.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        return { ok: res.ok, status: res.status, raw: await res.text() };
      },
      catch: (cause) => new W4pTransportError({ endpoint, cause }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new W4pTransportError({
          endpoint,
          status: response.status,
          body: response.raw,
        }),
      );
    }
    return yield* Effect.try({
      try: () => JSON.parse(response.raw) as unknown,
      catch: () =>
        new W4pResponseError({
          endpoint,
          message: 'invalid JSON in response',
          value: response.raw,
        }),
    });
  }).pipe((effect) =>
    ctx.rateLimiter.limit(retryTransient(effect, isTransientW4p)),
  );

const decode =
  <A, I>(schema: Schema.Schema<A, I>, endpoint: string) =>
  (body: unknown): Effect.Effect<A, W4pResponseError> =>
    Schema.decodeUnknown(schema, { onExcessProperty: 'preserve' })(body).pipe(
      Effect.mapError(
        (error) =>
          new W4pResponseError({
            endpoint,
            message: error.message,
            value: body,
          }),
      ),
    );

/** Fail on an unexpected reasonCode; `undefined` and Ok both pass. */
const failOnReason = (
  endpoint: string,
  reasonCode: number | undefined,
  reason: string | undefined,
) =>
  reasonCode !== undefined && reasonCode !== REASON.OK
    ? Effect.fail(
        new W4pApiError({
          endpoint,
          reasonCode,
          reason: reason ?? 'unexpected reasonCode',
        }),
      )
    : Effect.void;

const transactionList =
  (ctx: WayForPayClientOptions): WayForPayClient['transactionList'] =>
  (window) =>
    Effect.gen(function* () {
      const merchantSignature = signRequest(
        'TRANSACTION_LIST',
        {
          merchantAccount: ctx.merchantAccount,
          dateBegin: window.dateBegin,
          dateEnd: window.dateEnd,
        },
        ctx.merchantSecretKey,
      );
      const body = yield* postJson(ctx, ctx.apiUrl, 'TRANSACTION_LIST', {
        apiVersion: 1,
        transactionType: 'TRANSACTION_LIST',
        merchantAccount: ctx.merchantAccount,
        merchantSignature,
        dateBegin: window.dateBegin,
        dateEnd: window.dateEnd,
      });
      const parsed = yield* decode(
        W4pTransactionListResponseSchema,
        'TRANSACTION_LIST',
      )(body);
      const reasonCode = asReasonCode(parsed.reasonCode);
      if (reasonCode === REASON.WINDOW_TOO_LARGE) {
        return yield* Effect.fail(
          new W4pWindowTooLargeError({
            dateBegin: window.dateBegin,
            dateEnd: window.dateEnd,
            reason: parsed.reason ?? 'range too large',
          }),
        );
      }
      yield* failOnReason('TRANSACTION_LIST', reasonCode, parsed.reason);
      return parsed.transactionList ?? [];
    });

const checkStatus =
  (ctx: WayForPayClientOptions): WayForPayClient['checkStatus'] =>
  (orderReference) =>
    Effect.gen(function* () {
      const merchantSignature = signRequest(
        'CHECK_STATUS',
        { merchantAccount: ctx.merchantAccount, orderReference },
        ctx.merchantSecretKey,
      );
      const body = yield* postJson(ctx, ctx.apiUrl, 'CHECK_STATUS', {
        apiVersion: 1,
        transactionType: 'CHECK_STATUS',
        merchantAccount: ctx.merchantAccount,
        orderReference,
        merchantSignature,
      });
      const parsed = yield* decode(
        W4pCheckStatusResponseSchema,
        'CHECK_STATUS',
      )(body);
      const reasonCode = asReasonCode(parsed.reasonCode);
      if (reasonCode === REASON.ORDER_NOT_FOUND) {
        return yield* Effect.fail(
          new W4pOrderNotFoundError({ orderReference }),
        );
      }
      yield* failOnReason('CHECK_STATUS', reasonCode, parsed.reason);
      return parsed;
    });

const regularStatus =
  (ctx: WayForPayClientOptions): WayForPayClient['regularStatus'] =>
  (orderReference) =>
    Effect.gen(function* () {
      const body = yield* postJson(ctx, ctx.regularApiUrl, 'REGULAR_STATUS', {
        requestType: 'STATUS',
        merchantAccount: ctx.merchantAccount,
        merchantPassword: ctx.merchantPassword,
        orderReference,
      });
      const parsed = yield* decode(
        W4pRegularStatusResponseSchema,
        'REGULAR_STATUS',
      )(body);
      const reasonCode = asReasonCode(parsed.reasonCode);
      // 4100 (Ok) and 4107 (closed) both carry state; anything else is an error.
      if (
        reasonCode !== undefined &&
        reasonCode !== REASON.REGULAR_OK &&
        reasonCode !== REASON.REGULAR_CLOSED
      ) {
        return yield* Effect.fail(
          new W4pApiError({
            endpoint: 'REGULAR_STATUS',
            reasonCode,
            reason: parsed.reason ?? 'unexpected reasonCode',
          }),
        );
      }
      return parsed;
    });

export const makeWayForPayClient = (
  options: WayForPayClientOptions,
): WayForPayClient => ({
  transactionList: transactionList(options),
  checkStatus: checkStatus(options),
  regularStatus: regularStatus(options),
});

export const WayForPayLive = Layer.effect(
  WayForPay,
  Effect.gen(function* () {
    const config = yield* W4pConfig;
    const rateLimiter = yield* RateLimiterService;
    return makeWayForPayClient({
      merchantAccount: config.merchantAccount,
      merchantSecretKey: Redacted.value(config.merchantSecretKey),
      merchantPassword: Redacted.value(config.merchantPassword),
      apiUrl: config.apiUrl,
      regularApiUrl: config.regularApiUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    });
  }),
);
