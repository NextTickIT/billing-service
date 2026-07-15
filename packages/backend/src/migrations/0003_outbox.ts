import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0003 — the event outbox (docs/07, FR-011).
 *
 * `domain_events` durably stores every outgoing event BEFORE any delivery (00
 * §8.1); `event_deliveries` is one row per (event, sink) carrying the at-least-
 * once delivery state the operator can watch. Retries themselves ride the queue
 * (a `deliver_event` message per delivery), so this table records outcome, not
 * scheduling. Columns are camelCase double-quoted (row = shape verbatim);
 * `domain_events.id` is an app-minted `evt_…` string, so it is `text`, not a uuid
 * default.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS domain_events (
          id              text PRIMARY KEY,
          name            text NOT NULL,
          "occurredAt"    timestamptz NOT NULL,
          "correlationId" text NOT NULL,
          "externalUserId" text,
          "aggregateId"   text NOT NULL,
          payload         jsonb NOT NULL,
          "createdAt"     timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS event_deliveries (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "eventId"     text NOT NULL REFERENCES domain_events (id),
          sink          text NOT NULL,
          status        text NOT NULL DEFAULT 'pending',
          "attemptCount" int NOT NULL DEFAULT 0,
          "lastError"   jsonb,
          "deliveredAt" timestamptz,
          "createdAt"   timestamptz NOT NULL DEFAULT now(),
          "updatedAt"   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT event_deliveries_event_sink_key UNIQUE ("eventId", sink)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS event_deliveries_status_idx
          ON event_deliveries (status, "createdAt")
      `,
    ],
    { discard: true },
  ),
);
