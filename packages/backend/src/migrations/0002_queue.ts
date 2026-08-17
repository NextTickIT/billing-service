import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0002 — the durable message queue (docs/09-message_queue_recomendations.md).
 *
 * Four append-oriented tables that give the whole system one idempotent,
 * auditable path for every incoming event:
 *  - `raw_events`            R1: every receipt, including duplicates. Never updated.
 *  - `messages`             R2/R6: one row per unique invocation; the claimable queue.
 *  - `attempts`             R4: one row per processing attempt, with its result/error.
 *  - `message_status_events` R6: append-only status log; current status = latest row.
 *
 * Table names are snake_case (like `auth_tokens`); columns are the exact field
 * names used in code (camelCase, double-quoted so Postgres preserves the casing) —
 * a row is the shape verbatim, no name transform anywhere. These are infra tables,
 * not shared-schema entities, so ids are `bigserial` (high-churn append logs),
 * unlike the uuid domain tables.
 */
/** The live queue: the raw receipt log and the claimable message table. */
const queueTables = (sql: SqlClient.SqlClient) => [
  // R1 — append-only raw log. One row per receipt; duplicates included.
  sql`
    CREATE TABLE IF NOT EXISTS raw_events (
      id            bigserial PRIMARY KEY,
      "messageType" text NOT NULL,
      "idemKey"     text NOT NULL,
      payload       jsonb NOT NULL,
      "receivedAt"  timestamptz NOT NULL DEFAULT now(),
      "wasDuplicate" boolean NOT NULL
    )
  `,
  // R2/R6 — the queue. One row per unique (messageType, idemKey). `status` is a
  // denormalized cache of the latest message_status_events row, advanced only in
  // the same transaction that appends the status row, so the claim query filters
  // cheaply. Lifecycle: pending -> in_progress -> (retry -> in_progress)* -> success | fail.
  sql`
    CREATE TABLE IF NOT EXISTS messages (
      id            bigserial PRIMARY KEY,
      "messageType" text NOT NULL,
      "idemKey"     text NOT NULL,
      payload       jsonb NOT NULL,
      status        text NOT NULL DEFAULT 'pending',
      "attemptCount" int NOT NULL DEFAULT 0,
      "retryAt"     timestamptz,
      "lockedBy"    text,
      "lockedAt"    timestamptz,
      "createdAt"   timestamptz NOT NULL DEFAULT now(),
      "finishedAt"  timestamptz,
      CONSTRAINT messages_type_idem_key UNIQUE ("messageType", "idemKey")
    )
  `,
  // Partial index over exactly the claimable rows keeps the claim query hot.
  sql`
    CREATE INDEX IF NOT EXISTS messages_claimable
      ON messages ("retryAt", id)
      WHERE status IN ('pending', 'retry')
  `,
];

/** The history: per-attempt results and the append-only status transition log. */
const historyTables = (sql: SqlClient.SqlClient) => [
  // R4 — one row per attempt. Append-only; failures carry full error info.
  sql`
    CREATE TABLE IF NOT EXISTS attempts (
      id           bigserial PRIMARY KEY,
      "messageId"  bigint NOT NULL REFERENCES messages (id),
      "attemptNo"  int NOT NULL,
      "workerId"   text NOT NULL,
      "startedAt"  timestamptz NOT NULL,
      "finishedAt" timestamptz NOT NULL DEFAULT now(),
      status       text NOT NULL,
      result       jsonb,
      error        jsonb
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS attempts_message_id_idx ON attempts ("messageId")`,
  // R6 — append-only status transitions; the current status is the latest by time.
  sql`
    CREATE TABLE IF NOT EXISTS message_status_events (
      id           bigserial PRIMARY KEY,
      "messageId"  bigint NOT NULL REFERENCES messages (id),
      status       text NOT NULL,
      "occurredAt" timestamptz NOT NULL DEFAULT now(),
      detail       jsonb
    )
  `,
  sql`
    CREATE INDEX IF NOT EXISTS message_status_events_message_id_idx
      ON message_status_events ("messageId", "occurredAt")
  `,
];

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([...queueTables(sql), ...historyTables(sql)], { discard: true }),
);
