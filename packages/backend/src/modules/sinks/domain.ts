import {
  AuthKind,
  type Sink,
  type SinkAuth,
  type SinkView,
  type UpdateSinkRequest,
} from '@billing-service/shared';

import type { RateLimiter } from '@/infra/rate-limiter.js';
import type { SinkConnector } from '@/infra/sinks.js';
import {
  type FetchLike,
  makeSendPulseConnector,
} from '@/modules/sinks/sendpulse.js';

/** What building a connector needs beyond the per-sink config (stable across rebuilds). */
export interface ConnectorDeps {
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
  readonly apiUrl: string;
}

/**
 * Enabled sink rows → runtime connectors. One kind today (SendPulse); a new
 * `SinkKind` widens the `Sink` union and adds a branch here (AC8), at which point
 * `sink` must be narrowed on `sink.kind`.
 */
export const buildConnectors = (
  sinks: readonly Sink[],
  deps: ConnectorDeps,
): readonly SinkConnector[] =>
  sinks.flatMap((sink): readonly SinkConnector[] =>
    sink.enabled
      ? [
          makeSendPulseConnector(
            {
              token: sink.auth.token,
              apiUrl: deps.apiUrl,
              fetch: deps.fetch,
              rateLimiter: deps.rateLimiter,
            },
            sink.config.flows,
          ),
        ]
      : [],
  );

/** Public projection — strips the secret (`auth → { kind, hasToken }`). */
export const toView = (sink: Sink): SinkView => ({
  kind: sink.kind,
  enabled: sink.enabled,
  auth: { kind: sink.auth.kind, hasToken: sink.auth.token.length > 0 },
  config: sink.config,
  updatedAt: sink.updatedAt,
});

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

/** Apply an operator update onto the stored entity (write-only token merge). */
export const mergeUpdate = (current: Sink, patch: UpdateSinkRequest): Sink => ({
  kind: current.kind,
  enabled: patch.enabled ?? current.enabled,
  auth: mergeAuth(current.auth, patch.auth),
  config: patch.config ?? current.config,
  updatedAt: current.updatedAt, // the repo stamps `now()` on write
});
