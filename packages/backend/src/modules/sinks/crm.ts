import type { StoredEvent } from '@billing-service/shared';
import { Effect, Either, Schema } from 'effect';

import { isTransientStatus, retryTransient } from '@/infra/http/retry.js';
import type { RateLimiter } from '@/infra/rate-limiter.js';
import { SinkError, type SinkConnector } from '@/infra/sinks.js';
import type { FetchLike } from '@/modules/sinks/sendpulse.js';
import { snakeCaseKeys } from '@/modules/sinks/snake-case.js';

/**
 * CRM connector (docs/21 §14, which records the wire dialect). Runs ALONGSIDE the SendPulse sink, not instead of it: the
 * outbox fans each event out to one delivery per sink, so the two retry and fail
 * independently and a CRM outage cannot stop a customer message going out.
 *
 * Posts the whole envelope — not just the payload — because the CRM is the system of
 * record: it needs `id` to reference an event (and dedupes on it: `id` is the natural key
 * of a stored event), and `occurred_at` to order a history. Keys are snake_case, its chosen
 * dialect (see `snake-case.ts`), applied here and nowhere upstream.
 *
 * `aggregate_id` and `correlation_id` ride INSIDE the payload as well as at the top level.
 * The CRM's door keeps only `id, name, occurred_at, external_user_id, payload` of the
 * envelope and drops the rest, while its registry requires both subject fields in every
 * billing kind's payload — so a body with them only at the top level is stored
 * `rejected`. The top-level copies, and `idempotency_key`, stay for any reader that keys
 * on the envelope; the CRM ignores them.
 *
 * No `*_formatted` twins. Those exist because a SendPulse flow drops a value straight
 * into a sentence; the CRM renders its own UI from the canonical instant and duration, and
 * a pre-rendered Russian date string in a record would be wrong for any other reader.
 */
const SINK_NAME = 'crm';

export interface CrmClient {
  readonly token: string;
  /** Full ingest endpoint. Empty means "not configured": every delivery fails and waits
   * for the operator, never a silent success. */
  readonly url: string;
  readonly fetch: FetchLike;
  readonly rateLimiter: RateLimiter;
}

/**
 * How a failed POST is retried.
 * - `inCall`: a blip (network, 429, 5xx) — retried here with backoff, then by the queue.
 * - `queue`: worth asking again later, not right now — the queue's ladder only.
 * - `never`: the CRM refused the event; re-sending the same body cannot change that, so it
 *   dead-letters on this attempt.
 */
type Retry = 'inCall' | 'queue' | 'never';

interface CrmFail {
  readonly retry: Retry;
  readonly message: string;
  readonly cause?: unknown;
}

const failWith = (
  retry: Retry,
  message: string,
): Effect.Effect<never, CrmFail> => Effect.fail({ retry, message });

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
    payload: {
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      ...event.payload,
    },
  });

/** The CRM's 2xx answer (guildmaster `CrmEventAccepted`). */
const CrmAccepted = Schema.parseJson(
  Schema.Struct({
    status: Schema.Literal('ok'),
    event_id: Schema.String,
    schema_status: Schema.Literal('validated', 'unregistered', 'rejected'),
  }),
);

type SchemaStatus = Schema.Schema.Type<typeof CrmAccepted>['schema_status'];

/**
 * The kinds that move money. The CRM pays and attributes only on a `validated` row: one
 * stored `unregistered` or `rejected` is acknowledged and then never acted on. So for these
 * nothing but `validated` counts as delivered.
 */
const MONEY_KINDS: ReadonlySet<StoredEvent['name']> = new Set([
  'initial_payment_succeeded',
  'recurring_payment_succeeded',
  'one_time_purchase_succeeded',
]);

/** Is a stored `schema_status` a delivery, for this kind? */
const accepts = (name: StoredEvent['name'], status: SchemaStatus): boolean =>
  MONEY_KINDS.has(name) ? status === 'validated' : status !== 'rejected';

/**
 * A non-2xx status → how it is retried. A 401 is a token the operator has not fixed yet,
 * the same configuration gap as an empty token, so it waits on the queue rather than
 * dead-lettering every event until the fix; any other 4xx is the CRM refusing the event.
 */
const retryForStatus = (status: number): Retry => {
  if (isTransientStatus(status)) {
    return 'inCall';
  }
  if (status === 401) {
    return 'queue';
  }
  return status >= 400 && status < 500 ? 'never' : 'queue';
};

/** Judge a 2xx body against the event it acknowledges. */
const judgeAck = (
  event: StoredEvent,
  raw: string,
): Effect.Effect<void, CrmFail> =>
  Either.match(Schema.decodeUnknownEither(CrmAccepted)(raw), {
    // A proxy page or a truncated body says nothing about whether the CRM kept the
    // event; asking again is safe because the CRM dedupes on `id`.
    onLeft: () => failWith('queue', 'crm 2xx with an unreadable body'),
    onRight: (ack) =>
      accepts(event.name, ack.schema_status)
        ? Effect.void
        : failWith(
            'never',
            `crm stored ${event.name} as ${ack.schema_status} (event ${ack.event_id})`,
          ),
  });

/** What the sink row lacks for a delivery to be attempted at all. */
const missingConfig = (client: CrmClient): readonly string[] =>
  [
    client.url.length === 0 ? 'url' : null,
    client.token.length === 0 ? 'token' : null,
  ].filter((v): v is string => v !== null);

const post = (
  client: CrmClient,
  event: StoredEvent,
): Effect.Effect<
  { readonly ok: boolean; readonly status: number; readonly raw: string },
  CrmFail
> =>
  Effect.tryPromise({
    try: (signal) =>
      client
        .fetch(client.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${client.token}`,
            // The CRM dedupes on the body's `id`, never on this header. It stays so a
            // proxy or gateway in front of the CRM can collapse a retry without
            // parsing the body.
            'Idempotency-Key': event.idempotencyKey,
          },
          body: JSON.stringify(crmBody(event)),
          signal,
        })
        .then(async (r) => ({
          ok: r.ok,
          status: r.status,
          raw: await r.text(),
        })),
    catch: (cause): CrmFail => ({
      retry: 'inCall',
      message: 'crm network error',
      cause,
    }),
  });

const attempt = (
  client: CrmClient,
  event: StoredEvent,
): Effect.Effect<void, CrmFail> =>
  Effect.gen(function* () {
    const res = yield* post(client, event);
    if (!res.ok) {
      return yield* failWith(
        retryForStatus(res.status),
        `crm POST -> HTTP ${res.status.toString()}`,
      );
    }
    yield* judgeAck(event, res.raw);
  });

const toSinkError = (f: CrmFail): SinkError =>
  new SinkError({
    sink: SINK_NAME,
    reason: f.message,
    message: `${SINK_NAME}: ${f.message}`,
    cause: f.cause,
    permanent: f.retry === 'never',
  });

export const makeCrmConnector = (client: CrmClient): SinkConnector => ({
  name: SINK_NAME,
  deliver: (event: StoredEvent) => {
    const missing = missingConfig(client);
    if (missing.length > 0) {
      // Enabled without an endpoint or a token (the console refuses that state, but the
      // seeded row or a hand edit can reach it). A failed delivery the queue retries:
      // marking it delivered would lose the event without a trace.
      return Effect.fail(
        toSinkError({
          retry: 'queue',
          message: `crm sink enabled without ${missing.join(', ')}`,
        }),
      );
    }
    return client.rateLimiter
      .limit(
        retryTransient(attempt(client, event), (e) => e.retry === 'inCall'),
      )
      .pipe(Effect.mapError(toSinkError));
  },
});
