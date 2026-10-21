import {
  AuthKind,
  SinkKind,
  SinkKindCode,
  type Sink,
  type SinkAuth,
  type SinkView,
  type UpdateSinkRequest,
} from '@billing-service/shared';
import type { Effect, Option, Ref } from 'effect';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { SinkConnector } from '@/infra/sinks.js';
import { makeCrmConnector } from '@/modules/sinks/crm.js';
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
  /** The CRM's own limiter — a separate budget, so a CRM backlog cannot throttle the
   * customer-facing SendPulse deliveries sharing this process. */
  readonly crmRateLimiter: RateLimiter;
}

const emailConnector = (
  sink: Extract<Sink, { kind: SinkKind.Email }>,
  deps: ConnectorDeps,
): SinkConnector =>
  makeEmailConnector(
    {
      clientId: sink.config.clientId,
      // The OAuth client SECRET reuses the existing write-only token slot; `clientId`
      // is not secret and lives in plain config.
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
  );

/**
 * One enabled sink row → its runtime connector, narrowed on `sink.kind` (AC8).
 *
 * The switch is exhaustive on purpose — a new `SinkKind` fails to compile until it has a
 * branch here, which is cheaper than discovering at runtime that a configured sink
 * delivers nothing. The `default` does not weaken that: it asserts `never`, so adding a
 * kind still breaks the build, while a kind this IMAGE does not know about (rows are cast
 * rather than decoded) is dropped instead of returning `undefined` into the connector
 * list, which `outbox` would dereference and kill every event publish.
 */
const buildConnector = (
  sink: Sink,
  deps: ConnectorDeps,
): SinkConnector | null => {
  switch (sink.kind) {
    case SinkKind.SendPulse:
      return makeSendPulseConnector(
        {
          token: sink.auth.token,
          apiUrl: deps.apiUrl,
          fetch: deps.fetch,
          rateLimiter: deps.rateLimiter,
        },
        sink.config.flows,
      );
    case SinkKind.Crm:
      return makeCrmConnector({
        token: sink.auth.token,
        url: sink.config.url,
        fetch: deps.fetch,
        rateLimiter: deps.crmRateLimiter,
      });
    case SinkKind.Email:
      return emailConnector(sink, deps);
    default: {
      // Compile-time exhaustiveness survives: a NEW kind fails to assign to `never`.
      const unknownKind: never = sink;
      void unknownKind;
      return null;
    }
  }
};

/** Enabled sink rows → runtime connectors (see `buildConnector`). */
export const buildConnectors = (
  sinks: readonly Sink[],
  deps: ConnectorDeps,
): readonly SinkConnector[] =>
  sinks.flatMap((sink): readonly SinkConnector[] => {
    if (!sink.enabled) {
      return [];
    }
    const connector = buildConnector(sink, deps);
    return connector === null ? [] : [connector];
  });

/** Public projection — strips the secret (`auth → { kind, hasToken }`). Narrowed per
 * kind because `SinkView` is a DU: `kind` must be the literal, not the enum. */
export const toView = (sink: Sink): SinkView => {
  const auth = { kind: sink.auth.kind, hasToken: sink.auth.token.length > 0 };
  const common = { enabled: sink.enabled, auth, updatedAt: sink.updatedAt };
  switch (sink.kind) {
    case SinkKind.SendPulse:
      return { kind: sink.kind, ...common, config: sink.config };
    case SinkKind.Crm:
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
 * The update body's `config` is an untagged union — the kind comes from the route path,
 * not the body — so a `flows` map can arrive addressed to the CRM row and vice versa.
 * That is rejected rather than coerced or ignored: writing it would store a config no
 * connector reads, and the operator would have every reason to think the sink was
 * configured. Returns the reason so the route can answer 422.
 */
export type MergeOutcome =
  | { readonly ok: true; readonly sink: Sink }
  | { readonly ok: false; readonly reason: string };

/** The key that identifies each kind's config shape in the untagged update union. */
const CONFIG_KEY: Readonly<Record<SinkKind, string>> = {
  [SinkKind.SendPulse]: 'flows',
  [SinkKind.Crm]: 'url',
  [SinkKind.Email]: 'clientId',
};

/** Does this config match what the sink's kind expects? */
const configFits = (kind: SinkKind, config: object): boolean =>
  CONFIG_KEY[kind] in config;

/** The row with `config` replaced by the patch's, which `configFits` already vetted. */
const withConfig = (
  current: Sink,
  config: UpdateSinkRequest['config'],
): Sink => {
  if (config === undefined) {
    return current;
  }
  switch (current.kind) {
    case SinkKind.SendPulse:
      return 'flows' in config ? { ...current, config } : current;
    case SinkKind.Crm:
      return 'url' in config ? { ...current, config } : current;
    case SinkKind.Email:
      return 'clientId' in config ? { ...current, config } : current;
  }
};

/**
 * What an enabled CRM sink lacks to send anything. Checked on the merged row, so a patch
 * that enables the seeded row (empty URL and token) without filling both is refused;
 * disabling, or saving a half-filled row that stays disabled, is not.
 */
const crmMissing = (sink: Sink): readonly string[] =>
  sink.kind === SinkKind.Crm && sink.enabled
    ? [
        sink.config.url === '' ? 'url' : null,
        sink.auth.token === '' ? 'auth.token' : null,
      ].filter((v): v is string => v !== null)
    : [];

export const mergeUpdate = (
  current: Sink,
  patch: UpdateSinkRequest,
): MergeOutcome => {
  if (patch.config !== undefined && !configFits(current.kind, patch.config)) {
    return {
      ok: false,
      reason: `config does not match sink kind ${SinkKindCode[current.kind]}`,
    };
  }
  const sink: Sink = {
    ...withConfig(current, patch.config),
    enabled: patch.enabled ?? current.enabled,
    auth: mergeAuth(current.auth, patch.auth),
    updatedAt: current.updatedAt, // the repo stamps `now()` on write
  };
  const missing = crmMissing(sink);
  return missing.length > 0
    ? {
        ok: false,
        reason: `cannot enable the crm sink without: ${missing.join(', ')}`,
      }
    : { ok: true, sink };
};
