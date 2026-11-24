import { type Currency, CurrencyCode } from '@billing-service/shared';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import { RateLimiterService, type RateLimiter } from '@/infra/rate-limiter.js';
import { W4pConfig } from '@/modules/wayforpay/config.js';
import {
  REASON,
  type W4pChargeResponse,
  W4pChargeResponseSchema,
  type W4pCheckStatusResponse,
  W4pCheckStatusResponseSchema,
  type W4pRefundResponse,
  W4pRefundResponseSchema,
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
import { signPurchase, signRequest } from '@/modules/wayforpay/signature.js';
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
  /** Charge a stored token (recurring). A Declined result is returned, not failed. */
  readonly charge: (
    params: ChargeParams,
  ) => Effect.Effect<W4pChargeResponse, W4pError>;
  /** Refund a settled order, in ONE request (never retried here: a lost answer may hide
   * an accepted refund). A Declined result is returned, not failed. */
  readonly refund: (
    params: RefundParams,
  ) => Effect.Effect<W4pRefundResponse, W4pError>;
}

export interface RefundParams {
  readonly orderReference: string;
  readonly amount: number; // integer minor units
  readonly currency: Currency;
  readonly comment: string;
}

export interface ChargeParams {
  readonly orderReference: string;
  readonly amount: number; // integer minor units
  readonly currency: Currency;
  readonly recToken: string;
  readonly orderDate: number; // unix seconds
  readonly productName: string;
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
  readonly merchantDomainName: string;
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

/** POST JSON once and parse the body as JSON; transport + parse errors are typed. */
const postOnce = (
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
  });

/**
 * POST JSON and parse the body as JSON. Transient transport failures (network, 429, 5xx)
 * retry with backoff; parse and business reasonCodes do not. Every call is rate-limited.
 */
const postJson = (
  ctx: WayForPayClientOptions,
  url: string,
  endpoint: string,
  payload: unknown,
): Effect.Effect<unknown, W4pTransportError | W4pResponseError> =>
  ctx.rateLimiter.limit(
    retryTransient(postOnce(ctx, url, endpoint, payload), isTransientW4p),
  );

/**
 * One rate-limited POST, never repeated: for a call that moves money, where a lost
 * response may hide an accepted request and only a status check may decide what next.
 */
const postJsonOnce = (
  ctx: WayForPayClientOptions,
  url: string,
  endpoint: string,
  payload: unknown,
): Effect.Effect<unknown, W4pTransportError | W4pResponseError> =>
  ctx.rateLimiter.limit(postOnce(ctx, url, endpoint, payload));

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
  order: {
    readonly transactionStatus?: string | undefined;
    readonly processingDate?: string | number | null | undefined;
  } = {},
) =>
  reasonCode !== undefined && reasonCode !== REASON.OK
    ? Effect.fail(
        new W4pApiError({
          endpoint,
          reasonCode,
          reason: reason ?? 'unexpected reasonCode',
          ...(order.transactionStatus === undefined
            ? {}
            : { transactionStatus: order.transactionStatus }),
          ...(order.processingDate === undefined ||
          order.processingDate === null
            ? {}
            : { processingDate: order.processingDate }),
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
      yield* failOnReason('CHECK_STATUS', reasonCode, parsed.reason, parsed);
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

const charge =
  (ctx: WayForPayClientOptions): WayForPayClient['charge'] =>
  (params) =>
    Effect.gen(function* () {
      const amount = params.amount / 100;
      const currency = CurrencyCode[params.currency];
      const merchantSignature = signPurchase(
        {
          merchantAccount: ctx.merchantAccount,
          merchantDomainName: ctx.merchantDomainName,
          orderReference: params.orderReference,
          orderDate: params.orderDate,
          amount,
          currency,
          products: [{ name: params.productName, count: 1, price: amount }],
        },
        ctx.merchantSecretKey,
      );
      const body = yield* postJson(ctx, ctx.apiUrl, 'CHARGE', {
        apiVersion: 1,
        transactionType: 'CHARGE',
        merchantAccount: ctx.merchantAccount,
        merchantDomainName: ctx.merchantDomainName,
        orderReference: params.orderReference,
        orderDate: params.orderDate,
        amount,
        currency,
        productName: [params.productName],
        productCount: [1],
        productPrice: [amount],
        recToken: params.recToken,
        // Unattended token charge: request a non-3DS merchant-initiated SALE so the
        // scheduler can run without a cardholder present. Without this the account's
        // token CHARGE returns 5100 "Wait 3ds data" (docs 21-wayforpay-account-setup);
        // neither field is part of the signed base, so signPurchase is unchanged.
        merchantTransactionType: 'SALE',
        merchantTransactionSecureType: 'NON3DS',
        merchantSignature,
      });
      // A Declined charge is a valid response; the scheduler branches on it.
      return yield* decode(W4pChargeResponseSchema, 'CHARGE')(body);
    });

const refund =
  (ctx: WayForPayClientOptions): WayForPayClient['refund'] =>
  (params) =>
    Effect.gen(function* () {
      const amount = params.amount / 100;
      const currency = CurrencyCode[params.currency];
      const merchantSignature = signRequest(
        'REFUND',
        {
          merchantAccount: ctx.merchantAccount,
          orderReference: params.orderReference,
          amount,
          currency,
        },
        ctx.merchantSecretKey,
      );
      const body = yield* postJsonOnce(ctx, ctx.apiUrl, 'REFUND', {
        apiVersion: 1,
        transactionType: 'REFUND',
        merchantAccount: ctx.merchantAccount,
        orderReference: params.orderReference,
        amount,
        currency,
        comment: params.comment,
        merchantSignature,
      });
      return yield* decode(W4pRefundResponseSchema, 'REFUND')(body);
    });

export const makeWayForPayClient = (
  options: WayForPayClientOptions,
): WayForPayClient => ({
  transactionList: transactionList(options),
  checkStatus: checkStatus(options),
  regularStatus: regularStatus(options),
  charge: charge(options),
  refund: refund(options),
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
      merchantDomainName: config.merchantDomainName,
      apiUrl: config.apiUrl,
      regularApiUrl: config.regularApiUrl,
      fetch: (url, init) => globalThis.fetch(url, init),
      rateLimiter,
    });
  }),
);
