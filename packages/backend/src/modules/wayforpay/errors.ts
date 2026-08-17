import { Data } from 'effect';

/**
 * Tagged WayForPay client errors — part of the Effect error channel (handled with
 * `catchTag`, never thrown). reasonCodes that are a normal business situation
 * rather than a transport failure surface as their own typed errors so callers can
 * branch instead of the client crashing.
 */

const MAX_BODY_CHARS = 200;

/** Cap a response body in diagnostics so an error never floods the log. */
const truncateBody = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}…`
    : body;
};

/** Render an unknown cause for diagnostics — an Error reads best; a plain object
 * is JSON'd rather than collapsing to '[object Object]'. */
const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause !== 'object' || cause === null) {
    return String(cause);
  }
  return JSON.stringify(cause);
};

export class W4pTransportError extends Data.TaggedError('W4pTransportError')<{
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
}

export class W4pResponseError extends Data.TaggedError('W4pResponseError')<{
  readonly endpoint: string;
  readonly message: string;
  readonly value?: unknown;
}> {}

/** reasonCode 1109: TRANSACTION_LIST window exceeds the ~31-day cap. Handled by
 * splitting the range into ≤30-day chunks. */
export class W4pWindowTooLargeError extends Data.TaggedError(
  'W4pWindowTooLargeError',
)<{
  readonly dateBegin: number;
  readonly dateEnd: number;
  readonly reason: string;
}> {}

/** reasonCode 1127: order not found in CHECK_STATUS. An expected case (e.g. a
 * renewal echo-payment that never existed in W4P) — not an exception. */
export class W4pOrderNotFoundError extends Data.TaggedError(
  'W4pOrderNotFoundError',
)<{
  readonly orderReference: string;
}> {}

export class W4pApiError extends Data.TaggedError('W4pApiError')<{
  readonly endpoint: string;
  readonly reasonCode: number;
  readonly reason: string;
}> {}

export type W4pError =
  | W4pTransportError
  | W4pResponseError
  | W4pWindowTooLargeError
  | W4pOrderNotFoundError
  | W4pApiError;
