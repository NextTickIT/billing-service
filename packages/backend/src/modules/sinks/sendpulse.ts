import type {
  SinkFlow,
  SinkFlowMap,
  StoredEvent,
} from '@billing-service/shared';
import { Effect } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import type { RateLimiter } from '@/infra/rate-limiter.js';
import { SinkError, type SinkConnector } from '@/infra/sinks.js';

/**
 * SendPulse Telegram connector (docs/21, conv.12 — provider code lives here). Runs a
 * SendPulse flow per outgoing event: `POST {apiUrl}/flows/run` with `contact_id =
 * externalUserId`, `flow_id` from the operator's map, `external_data = event payload`.
 * Auth is a static `sp_apikey_***` Bearer. Every non-success maps to `SinkError` so the
 * durable outbox retries (§4.5); transient blips (network/429/5xx) also retry in-call.
 */
const SINK_NAME = 'sendpulse';

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SendPulseClient {
  readonly token: string;
  /** Base, e.g. `https://api.sendpulse.com/telegram`. */
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

interface HttpFail {
  readonly transient: boolean;
  readonly message: string;
  readonly cause?: unknown;
}

const toSinkError = (f: HttpFail): SinkError =>
  new SinkError({ sink: SINK_NAME, reason: f.message, cause: f.cause });

/** One rate-limited call; transient failures retry, then any failure is an `HttpFail`. */
const call = (
  client: SendPulseClient,
  method: string,
  path: string,
  body?: string,
): Effect.Effect<string, HttpFail> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: (signal) =>
        client
          .fetch(`${client.apiUrl}${path}`, {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${client.token}`,
            },
            ...(body === undefined ? {} : { body }),
            signal,
          })
          .then(async (r) => ({
            ok: r.ok,
            status: r.status,
            raw: await r.text(),
          })),
      catch: (cause): HttpFail => ({
        transient: true,
        message: 'sendpulse network error',
        cause,
      }),
    });
    if (!res.ok) {
      return yield* Effect.fail<HttpFail>({
        transient: isTransientStatus(res.status),
        message: `sendpulse ${method} ${path} -> HTTP ${res.status.toString()}`,
      });
    }
    return res.raw;
  }).pipe((effect) =>
    client.rateLimiter.limit(retryTransient(effect, (e) => e.transient)),
  );

/** Parse the `{ success, data }` envelope; a non-JSON / `success:false` body fails. */
const parseData = (raw: string): Effect.Effect<unknown, HttpFail> =>
  Effect.try({
    try: () => {
      const body = JSON.parse(raw) as { success?: boolean; data?: unknown };
      if (body.success === false) {
        throw new Error('sendpulse success=false');
      }
      return body.data;
    },
    catch: (cause): HttpFail => ({
      transient: false,
      message: 'sendpulse: invalid or unsuccessful response',
      cause,
    }),
  });

export const makeSendPulseConnector = (
  client: SendPulseClient,
  flows: SinkFlowMap,
): SinkConnector => ({
  name: SINK_NAME,
  deliver: (event: StoredEvent) =>
    Effect.gen(function* () {
      if (event.externalUserId === null) {
        return; // no contact to target (e.g. quarantine event)
      }
      const flowId = flows[event.name];
      if (flowId === undefined || flowId.length === 0) {
        return; // event not mapped to a flow — nothing to run
      }
      const body = JSON.stringify({
        contact_id: event.externalUserId,
        flow_id: flowId,
        external_data: { ...event.payload, event_id: event.id },
      });
      yield* call(client, 'POST', '/flows/run', body).pipe(
        Effect.flatMap(parseData),
        Effect.mapError(toSinkError),
      );
    }),
});

interface BotRef {
  readonly id: string;
  readonly name: string;
}

/** SendPulse `data` → active bots (status 3 = active). */
const asBots = (data: unknown): readonly BotRef[] =>
  Array.isArray(data)
    ? data.flatMap((b): readonly BotRef[] => {
        const rec = b as {
          id?: unknown;
          status?: unknown;
          channel_data?: { name?: unknown };
        };
        if (typeof rec.id !== 'string' || rec.status !== 3) {
          return [];
        }
        const name = rec.channel_data?.name;
        return [{ id: rec.id, name: typeof name === 'string' ? name : rec.id }];
      })
    : [];

/** SendPulse `data` → active flows (status 1 = active). */
const asFlows = (data: unknown, botName: string): readonly SinkFlow[] =>
  Array.isArray(data)
    ? data.flatMap((f): readonly SinkFlow[] => {
        const rec = f as { id?: unknown; name?: unknown; status?: unknown };
        if (typeof rec.id !== 'string' || rec.status !== 1) {
          return [];
        }
        return [
          {
            id: rec.id,
            name: typeof rec.name === 'string' ? rec.name : rec.id,
            botName,
          },
        ];
      })
    : [];

/**
 * List selectable flows for the operator picker: bots then flows-per-bot, merged.
 * Run on the API server for the `GET /api/sinks/:code/flows` route (token stays server-side).
 */
export const listFlows = (
  client: SendPulseClient,
): Effect.Effect<readonly SinkFlow[], SinkError> =>
  Effect.gen(function* () {
    const bots = asBots(
      yield* call(client, 'GET', '/bots').pipe(
        Effect.flatMap(parseData),
        Effect.mapError(toSinkError),
      ),
    );
    const perBot = yield* Effect.forEach(bots, (bot) =>
      call(client, 'GET', `/flows?bot_id=${encodeURIComponent(bot.id)}`).pipe(
        Effect.flatMap(parseData),
        Effect.map((data) => asFlows(data, bot.name)),
        Effect.mapError(toSinkError),
      ),
    );
    return perBot.flat();
  });
