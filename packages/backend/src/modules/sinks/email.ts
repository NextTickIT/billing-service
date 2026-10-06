import type { StoredEvent } from '@billing-service/shared';
import { Effect, Option, Ref } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import type { RateLimiter } from '@/infra/rate-limiter.js';
import { SinkError, type SinkConnector } from '@/infra/sinks.js';
import { renderReceipt } from '@/modules/sinks/receipt.js';
import type { FetchLike } from '@/modules/sinks/sendpulse.js';

/**
 * Email sink — transactional receipts over SendPulse's SMTP API.
 *
 * Why this channel exists at all: every other path to a buyer needs them to already
 * exist somewhere. The chatbot needs a SendPulse contact, which is created only on
 * first interaction and cannot be created by any API, so a first-time buyer is
 * unreachable there at the moment they pay. The browser needs them not to have closed
 * it, which crypto settlement (minutes to hours) guarantees they have. Email needs
 * only an address, which the checkout already collects.
 *
 * Two deliberate differences from the chatbot connector:
 *
 * 1. **Auth is OAuth client-credentials, not a static key.** SendPulse's REST API
 *    issues a short-lived token from `POST /oauth/access_token`; it is cached here and
 *    refreshed just before expiry, and a 401 drops the cache so the next attempt
 *    re-mints rather than failing forever on a rotated secret.
 * 2. **The address is resolved, not carried on the event.** `resolveEmail` reads it
 *    from the purchase at delivery time, so a customer's email never lands in
 *    `domain_events.payload` and is never shipped to the chatbot as flow variables.
 *
 * `config.events` is the declared scope: an event outside it is NOT an error, it simply
 * is not a message this channel sends. An event INSIDE it with no address on file IS an
 * error, because that means capture is broken and someone must hear about it.
 */
const SINK_NAME = 'email';

/** Token endpoint lives on the REST root, not the chatbot base. */
const TOKEN_PATH = '/oauth/access_token';
const SEND_PATH = '/smtp/emails';

/** Refresh this far before the stated expiry, so an in-flight send cannot race it. */
const EXPIRY_SKEW_MILLIS = 60_000;

/** Used only when the provider states no usable `expires_in`. */
const DEFAULT_TTL_MILLIS = 60_000;

export interface CachedToken {
  readonly token: string;
  /** The provider's stated expiry, never stretched. */
  readonly expiresAtMillis: number;
  /**
   * How long we are willing to REUSE it — always strictly before `expiresAtMillis`.
   * Kept separate because flooring the expiry itself would hand out a DEAD token: the
   * resulting 401 is non-transient, so that delivery hard-fails and dead-letters, and
   * dropping the cache only helps the next one.
   */
  readonly reuseUntilMillis: number;
}

export interface EmailSender {
  readonly name: string;
  readonly email: string;
}

export interface EmailClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** REST base, e.g. `https://api.sendpulse.com` (NOT the `/telegram` chatbot base). */
  readonly apiUrl: string;
  readonly from: EmailSender;
  readonly replyTo: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
  readonly tokenCache: Ref.Ref<CachedToken | null>;
  /** The payer's address for this event's owner, or None when nothing is on file. */
  readonly resolveEmail: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<string>>;
}

interface HttpFail {
  readonly transient: boolean;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}

const toSinkError = (f: HttpFail): SinkError =>
  new SinkError({
    sink: SINK_NAME,
    reason: f.message,
    // Carried so `describeError` has real text to store even before the shared
    // `SinkError.message` fix lands; a receipt that fails unreadably is no better
    // than one that never sends.
    message: `${SINK_NAME}: ${f.message}`,
    cause: f.cause,
  });

const request = (
  ctx: EmailClientOptions,
  path: string,
  body: unknown,
  token: string | null,
): Effect.Effect<string, HttpFail> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        ctx
          .fetch(`${ctx.apiUrl}${path}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
            },
            body: JSON.stringify(body),
            signal,
          })
          .then(async (r) => ({
            ok: r.ok,
            status: r.status,
            raw: await r.text(),
          })),
      catch: (cause): HttpFail => ({
        transient: true,
        message: `email network error on ${path}`,
        cause,
      }),
    });
    if (!res.ok) {
      return yield* Effect.fail<HttpFail>({
        transient: isTransientStatus(res.status),
        status: res.status,
        // Status and path only. The body is the provider echoing our request back,
        // and the recipient address is the one customer datum in it — this string is
        // persisted to `event_deliveries."lastError"`, so it must not carry PII.
        message: `email POST ${path} -> HTTP ${res.status.toString()}`,
      });
    }
    return res.raw;
  }).pipe((effect) =>
    ctx.rateLimiter.limit(retryTransient(effect, (e) => e.transient)),
  );

/** Mint a token. `expires_in` is seconds; a missing/garbage value falls back to a
 * conservative minute so we re-mint often rather than send with a dead token. */
const mintToken = (
  ctx: EmailClientOptions,
  nowMillis: number,
): Effect.Effect<CachedToken, HttpFail> =>
  request(
    ctx,
    TOKEN_PATH,
    {
      grant_type: 'client_credentials',
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    },
    null,
  ).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: (): CachedToken => {
          const body = JSON.parse(raw) as {
            access_token?: unknown;
            expires_in?: unknown;
          };
          if (typeof body.access_token !== 'string' || body.access_token === '')
            throw new Error('no access_token in response');
          // Some OAuth servers send `expires_in` as a string; `Number()` takes both.
          const stated = Number(body.expires_in);
          const ttl =
            Number.isFinite(stated) && stated > 0
              ? stated * 1000
              : DEFAULT_TTL_MILLIS;
          // Refresh early, but never by so much that the reuse window closes before it
          // opens — that is what silently turned caching off and minted one token per
          // receipt. Never past the stated expiry either.
          const skew = Math.min(EXPIRY_SKEW_MILLIS, Math.floor(ttl / 2));
          return {
            token: body.access_token,
            expiresAtMillis: nowMillis + ttl,
            reuseUntilMillis: nowMillis + ttl - skew,
          };
        },
        catch: (cause): HttpFail => ({
          transient: false,
          message: 'email: invalid token response',
          cause,
        }),
      }),
    ),
  );

const tokenFor = (ctx: EmailClientOptions): Effect.Effect<string, HttpFail> =>
  Effect.gen(function* () {
    const now = yield* Effect.clockWith((c) => c.currentTimeMillis);
    const cached = yield* Ref.get(ctx.tokenCache);
    if (cached !== null && cached.reuseUntilMillis > now) {
      return cached.token;
    }
    const minted = yield* mintToken(ctx, now);
    yield* Ref.set(ctx.tokenCache, minted);
    return minted.token;
  });

/**
 * SendPulse answers a REJECTED send with HTTP 200 and a falsy envelope, exactly as the
 * chatbot API does (`sendpulse.ts` `parseData` exists for the same reason). Without
 * this check `deliver` succeeds, the delivery row is marked delivered, the watchdog
 * stays quiet — and the buyer gets nothing. That is the precise failure this channel
 * was built to eliminate, so a falsy envelope is a hard failure.
 *
 * Unparseable JSON is NOT failed: the send may well have happened, and failing here
 * would re-send on retry. A shape we do not recognise is left alone.
 */
const assertSent = (raw: string): Effect.Effect<void, HttpFail> => {
  let body: { result?: unknown; is_error?: unknown; message?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return Effect.void;
  }
  if (body.result !== false && body.is_error !== true) {
    return Effect.void;
  }
  // The provider's own text ("quota exceeded", "sender not verified") is the only
  // string that says WHY, and it is provider copy rather than customer data — so it is
  // safe to persist, unlike the echoed request body.
  const stated = typeof body.message === 'string' ? body.message : '';
  return Effect.fail<HttpFail>({
    transient: false,
    message:
      stated === ''
        ? 'email: provider rejected the send'
        : `email: provider rejected the send: ${stated.slice(0, 200)}`,
  });
};

/** SendPulse wants the HTML base64-encoded inside the `email` envelope. */
const b64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64');

export const makeEmailConnector = (
  ctx: EmailClientOptions,
  events: readonly string[],
): SinkConnector => ({
  name: SINK_NAME,
  deliver: (event: StoredEvent) =>
    Effect.gen(function* () {
      if (!events.includes(event.name)) {
        return; // declared out of scope for this channel — not a failure
      }
      if (event.externalUserId === null) {
        return; // no owner to address (a quarantine event) — also out of scope
      }
      const rendered = renderReceipt(event);
      if (rendered === null) {
        // Configured to email an event the template has no copy for. Loud on purpose:
        // the alternative is a customer-shaped gap nobody sees.
        return yield* Effect.fail(
          toSinkError({
            transient: false,
            message: `no receipt template for event ${event.name}`,
          }),
        );
      }
      const address = yield* ctx.resolveEmail(event.externalUserId);
      if (Option.isNone(address)) {
        return yield* Effect.fail(
          toSinkError({
            transient: false,
            message: `no email on file for ${event.externalUserId}`,
          }),
        );
      }
      const token = yield* tokenFor(ctx).pipe(Effect.mapError(toSinkError));
      const sent = yield* request(
        ctx,
        SEND_PATH,
        {
          email: {
            subject: rendered.subject,
            from: { name: ctx.from.name, email: ctx.from.email },
            to: [{ email: address.value }],
            html: b64(rendered.html),
            text: rendered.text,
            ...(ctx.replyTo === '' ? {} : { reply_to: ctx.replyTo }),
          },
        },
        token,
      ).pipe(
        // A 401 means the cached token died early (rotated secret, revoked key).
        // Drop it so the next attempt re-mints instead of replaying a dead token
        // through all five retries.
        Effect.tapError((f) =>
          f.status === 401 ? Ref.set(ctx.tokenCache, null) : Effect.void,
        ),
        Effect.mapError(toSinkError),
      );
      yield* assertSent(sent).pipe(Effect.mapError(toSinkError));
    }),
});
