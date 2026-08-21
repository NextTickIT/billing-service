import { Data } from 'effect';

import type { HttpReply } from '@/infra/http/reply.js';

/**
 * Tagged WhitePay client errors — the Effect error channel, never thrown. Each maps
 * to HTTP for the on-click `pay` route (the only place a WhitePay call is request-
 * scoped): a provider/transport fault is a 502 Bad Gateway, an unparseable body a 502
 * too, and a crypto-disabled/unconfigured method a 503 (try again once provisioned).
 */

const MAX_BODY_CHARS = 200;

const truncateBody = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}…`
    : body;
};

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause !== 'object' || cause === null) {
    return String(cause);
  }
  return JSON.stringify(cause);
};

export class WhitePayTransportError extends Data.TaggedError(
  'WhitePayTransportError',
)<{
  readonly endpoint: string;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    const parts: string[] = [this.endpoint];
    if (this.status !== undefined) {
      parts.push(`→ ${this.status.toString()}`);
    }
    const body = truncateBody(this.body);
    if (body !== undefined && body.length > 0) {
      parts.push(`body=${body}`);
    }
    if (this.cause !== undefined) {
      parts.push(`cause=${describeCause(this.cause)}`);
    }
    return parts.join(' ');
  }

  toHttp(): HttpReply {
    return { status: 502, body: { error: 'payment provider unavailable' } };
  }
}

export class WhitePayResponseError extends Data.TaggedError(
  'WhitePayResponseError',
)<{
  readonly endpoint: string;
  readonly message: string;
  readonly value?: unknown;
}> {
  toHttp(): HttpReply {
    return {
      status: 502,
      body: { error: 'invalid payment provider response' },
    };
  }
}

/** The crypto method was requested while WhitePay is disabled or unconfigured
 * (docs/25). 503 → the caller retries once credentials are provisioned. */
export class CryptoPaymentUnavailable extends Data.TaggedError(
  'CryptoPaymentUnavailable',
)<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 503, body: { error: 'crypto payment unavailable' } };
  }
}

/**
 * WhitePay rejected the create-order request itself (HTTP 400/422) — e.g. an amount
 * below the provider's minimum order value. This is a permanent CLIENT condition, not a
 * provider outage, so it maps to 422 (not the 502 a transport failure gets) and carries
 * the provider's own message so the checkout page can explain it (docs/26).
 */
export class CryptoOrderRejected extends Data.TaggedError(
  'CryptoOrderRejected',
)<{
  readonly reason: string;
}> {
  toHttp(): HttpReply {
    return { status: 422, body: { error: this.reason } };
  }
}

export type WhitePayError =
  WhitePayTransportError | WhitePayResponseError | CryptoOrderRejected;
