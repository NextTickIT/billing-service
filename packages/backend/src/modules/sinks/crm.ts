import type { StoredEvent } from '@billing-service/shared';
import { Effect } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import type { RateLimiter } from '@/infra/rate-limiter.js';
import { SinkError, type SinkConnector } from '@/infra/sinks.js';
import type { FetchLike } from '@/modules/sinks/sendpulse.js';
import { snakeCaseKeys } from '@/modules/sinks/snake-case.js';

/**
 * CRM connector (docs/21). Runs ALONGSIDE the SendPulse sink, not instead of it: the
 * outbox fans each event out to one delivery per sink, so the two retry and fail
 * independently and a CRM outage cannot stop a customer message going out.
 *
 * Posts the whole envelope — not just the payload — because the CRM is the system of
 * record: it needs `id` to reference an event, `idempotency_key` to collapse a redelivery,
 * and `occurred_at` to order a history. Keys are snake_case, its chosen dialect
 * (see `snake-case.ts`), applied here and nowhere upstream.
 *
 * No `*_formatted` twins. Those exist because a SendPulse flow drops a value straight
 * into a sentence; the CRM renders its own UI from the canonical instant and duration, and
 * a pre-rendered Russian date string in a record would be wrong for any other reader.
 */
const SINK_NAME = 'crm';

export interface CrmClient {
  readonly token: string;
  /** Full ingest endpoint; empty means "not configured" and delivery is skipped. */
  readonly url: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

interface HttpFail {
  readonly transient: boolean;
  readonly message: string;
  readonly cause?: unknown;
}

/** The wire body: the envelope, renamed. Exported so a test asserts the contract. */
export const crmBody = (event: StoredEvent): unknown =>
  snakeCaseKeys({
    id: event.id,
    idempotencyKey: event.idempotencyKey,
    name: event.name,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId,
    externalUserId: event.externalUserId,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });

export const makeCrmConnector = (client: CrmClient): SinkConnector => ({
  name: SINK_NAME,
  deliver: (event: StoredEvent) =>
    Effect.gen(function* () {
      if (client.url.length === 0) {
        // Enabled but never pointed anywhere. Succeeding here (rather than failing) keeps
        // a half-configured sink from dead-lettering every event in the system; the
        // operator sees deliveries marked delivered against a sink with no URL, which is
        // a configuration problem, not a lost event — nothing was ever meant to be sent.
        yield* Effect.logWarning(
          'crm sink enabled with no url — skipping',
        ).pipe(Effect.annotateLogs({ sink: SINK_NAME, event: event.name }));
        return;
      }
      const body = JSON.stringify(crmBody(event));
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          client
            .fetch(client.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${client.token}`,
                // The CRM dedupes on this rather than on `id`, so it travels in a header
                // too: a proxy or gateway in front of it can collapse a retry without
                // parsing the body.
                'Idempotency-Key': event.idempotencyKey,
              },
              body,
              signal,
            })
            .then(async (r) => ({
              ok: r.ok,
              status: r.status,
              raw: await r.text(),
            })),
        catch: (cause): HttpFail => ({
          transient: true,
          message: 'crm network error',
          cause,
        }),
      });
      if (!res.ok) {
        return yield* Effect.fail<HttpFail>({
          transient: isTransientStatus(res.status),
          message: `crm POST -> HTTP ${res.status.toString()}`,
        });
      }
    }).pipe(
      (effect) =>
        client.rateLimiter.limit(retryTransient(effect, (e) => e.transient)),
      Effect.mapError(
        (f) =>
          new SinkError({ sink: SINK_NAME, reason: f.message, cause: f.cause }),
      ),
    ),
});
