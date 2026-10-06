import {
  AuthKind,
  SinkKind,
  SinkKindCode,
  type Sink,
  type SinkAuth,
  type SinkView,
  type UpdateSinkRequest,
} from '@billing-service/shared';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { SinkConnector } from '@/infra/sinks.js';
import { makeCrmConnector } from '@/modules/sinks/crm.js';
import {
  type FetchLike,
  makeSendPulseConnector,
} from '@/modules/sinks/sendpulse.js';

/** What building a connector needs beyond the per-sink config (stable across rebuilds). */
export interface ConnectorDeps {
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
  readonly apiUrl: string;
  /** The CRM's own limiter — a separate budget, so a CRM backlog cannot throttle the
   * customer-facing SendPulse deliveries sharing this process. */
  readonly crmRateLimiter: RateLimiter;
}

/**
 * Enabled sink rows → runtime connectors, narrowed on `sink.kind`. A new `SinkKind`
 * widens the `Sink` union and adds a branch here (AC8); the switch is exhaustive, so a
 * new kind fails to compile until it has one rather than silently delivering nowhere.
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
  }
};

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

/** Public projection — strips the secret (`auth → { kind, hasToken }`). */
export const toView = (sink: Sink): SinkView => {
  const auth = {
    kind: sink.auth.kind,
    hasToken: sink.auth.token.length > 0,
  };
  // Rebuilt per kind rather than spread: `SinkView` is a union, and a spread of the
  // entity would let a config of the wrong shape through on a future kind.
  return sink.kind === SinkKind.SendPulse
    ? {
        kind: sink.kind,
        enabled: sink.enabled,
        auth,
        config: sink.config,
        updatedAt: sink.updatedAt,
      }
    : {
        kind: sink.kind,
        enabled: sink.enabled,
        auth,
        config: sink.config,
        updatedAt: sink.updatedAt,
      };
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

/** Does this config match what the sink's kind expects? */
const configFits = (kind: SinkKind, config: object): boolean =>
  kind === SinkKind.SendPulse ? 'flows' in config : 'url' in config;

export const mergeUpdate = (
  current: Sink,
  patch: UpdateSinkRequest,
): MergeOutcome => {
  const enabled = patch.enabled ?? current.enabled;
  const auth = mergeAuth(current.auth, patch.auth);
  const updatedAt = current.updatedAt; // the repo stamps `now()` on write
  if (patch.config !== undefined && !configFits(current.kind, patch.config)) {
    return {
      ok: false,
      reason: `config does not match sink kind ${SinkKindCode[current.kind]}`,
    };
  }
  if (current.kind === SinkKind.SendPulse) {
    const config =
      patch.config !== undefined && 'flows' in patch.config
        ? patch.config
        : current.config;
    return {
      ok: true,
      sink: { kind: current.kind, enabled, auth, config, updatedAt },
    };
  }
  const config =
    patch.config !== undefined && 'url' in patch.config
      ? patch.config
      : current.config;
  return {
    ok: true,
    sink: { kind: current.kind, enabled, auth, config, updatedAt },
  };
};
