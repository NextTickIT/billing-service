import {
  AuthKind,
  type Sink,
  type SinkAuth,
  SinkKind,
  type SinkView,
  type UpdateSinkRequest,
} from '@billing-service/shared';
import type { Effect, Option, Ref } from 'effect';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { SinkConnector } from '@/infra/sinks.js';
import { type CachedToken, makeEmailConnector } from '@/modules/sinks/email.js';
import {
  type FetchLike,
  makeSendPulseConnector,
} from '@/modules/sinks/sendpulse.js';

/** What building a connector needs beyond the per-sink config (stable across rebuilds). */
export interface ConnectorDeps {
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
  /** Chatbot base (`…/telegram`) — the SendPulse flow connector. */
  readonly apiUrl: string;
  /** REST base (`https://api.sendpulse.com`) — the transactional email API. */
  readonly emailApiUrl: string;
  readonly emailRateLimiter: RateLimiter;
  /**
   * Shared OAuth token cache. Built ONCE and passed in, like the rate limiters, so a
   * config rebuild (every cache TTL) does not throw away a live token and re-mint on
   * the next send.
   */
  readonly emailTokenCache: Ref.Ref<CachedToken | null>;
  readonly resolveEmail: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<string>>;
}

/**
 * Enabled sink rows → runtime connectors, narrowed on `sink.kind` (AC8). The switch is
 * exhaustive on purpose: a new `SinkKind` fails to compile until it has a branch here,
 * which is cheaper than discovering at runtime that a configured sink delivers nothing.
 */
export const buildConnectors = (
  sinks: readonly Sink[],
  deps: ConnectorDeps,
): readonly SinkConnector[] =>
  sinks.flatMap((sink): readonly SinkConnector[] => {
    if (!sink.enabled) {
      return [];
    }
    switch (sink.kind) {
      case SinkKind.SendPulse:
        return [
          makeSendPulseConnector(
            {
              token: sink.auth.token,
              apiUrl: deps.apiUrl,
              fetch: deps.fetch,
              rateLimiter: deps.rateLimiter,
            },
            sink.config.flows,
          ),
        ];
      case SinkKind.Email:
        return [
          makeEmailConnector(
            {
              clientId: sink.config.clientId,
              // The OAuth client SECRET reuses the existing write-only token slot;
              // `clientId` is not secret and lives in plain config.
              clientSecret: sink.auth.token,
              apiUrl: deps.emailApiUrl,
              from: sink.config.from,
              replyTo: sink.config.replyTo,
              fetch: deps.fetch,
              rateLimiter: deps.emailRateLimiter,
              tokenCache: deps.emailTokenCache,
              resolveEmail: deps.resolveEmail,
            },
            sink.config.events,
          ),
        ];
      // Unreachable per the union, reachable in production: `listWithSecret` CASTS rows
      // rather than decoding them, so a kind this image does not know about (a row
      // written by another deploy line) arrives here. Falling through would return
      // `undefined` into the connector list, and `outbox` reads `.name` off every
      // entry — which would kill event publishing for EVERY event, not just this sink.
      default:
        return [];
    }
  });

/** Public projection — strips the secret (`auth → { kind, hasToken }`). Narrowed per
 * kind because `SinkView` is a DU: `kind` must be the literal, not the enum. */
export const toView = (sink: Sink): SinkView => {
  const auth = { kind: sink.auth.kind, hasToken: sink.auth.token.length > 0 };
  const common = { enabled: sink.enabled, auth, updatedAt: sink.updatedAt };
  switch (sink.kind) {
    case SinkKind.SendPulse:
      return { kind: sink.kind, ...common, config: sink.config };
    case SinkKind.Email:
      return { kind: sink.kind, ...common, config: sink.config };
  }
};

/** One auth strategy today: keep the stored token when the patch omits/empties it. */
const mergeAuth = (
  current: SinkAuth,
  patch: UpdateSinkRequest['auth'],
): SinkAuth => {
  if (patch === undefined) {
    return current;
  }
  const token =
    patch.token !== undefined && patch.token.length > 0
      ? patch.token
      : current.token;
  return { kind: AuthKind.Bearer, token };
};

/**
 * Apply an operator update onto the stored entity (write-only token merge).
 *
 * The config patch is accepted only when its SHAPE matches the row's kind, so a flows
 * map cannot be written onto the email sink (or vice versa) just because both arrive
 * through one route. A mismatched config is ignored rather than rejected — the route
 * has no error channel here; validating it there is a follow-up.
 */
export const mergeUpdate = (current: Sink, patch: UpdateSinkRequest): Sink => {
  const common = {
    enabled: patch.enabled ?? current.enabled,
    auth: mergeAuth(current.auth, patch.auth),
    updatedAt: current.updatedAt, // the repo stamps `now()` on write
  };
  switch (current.kind) {
    case SinkKind.SendPulse:
      return {
        kind: current.kind,
        ...common,
        config:
          patch.config !== undefined && 'flows' in patch.config
            ? patch.config
            : current.config,
      };
    case SinkKind.Email:
      return {
        kind: current.kind,
        ...common,
        config:
          patch.config !== undefined && 'clientId' in patch.config
            ? patch.config
            : current.config,
      };
  }
};
