import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0004 — the incoming-payment pipeline (docs/05, FR-007/009).
 *
 * Every payment fact (callback, our charge result, poller finding) lands in
 * `incoming_payment_events` once (unique on the source idempotency key), is
 * matched to a subscription/checkout, and becomes either a `payments` row or a
 * `quarantine_records` row (FR-009). `audit_log` records every manual operator
 * action (00 §8.6). `subscriptionId` columns are intentionally FK-less until the
 * subscriptions table lands (M5/M6). Amounts are integer minimal units; currency
 * is the numeric Currency enum (smallint), matching the shared shape verbatim.
 */
const paymentTables = (sql: SqlClient.SqlClient) => [
  sql`
    CREATE TABLE IF NOT EXISTS incoming_payment_events (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source         text NOT NULL,
      "idemKey"      text NOT NULL,
      "externalRef"  text NOT NULL,
      "externalUserId" text,
      amount         integer NOT NULL,
      currency       smallint NOT NULL,
      status         text NOT NULL,
      "occurredAt"   timestamptz NOT NULL,
      "matchResult"  text NOT NULL DEFAULT 'unmatched',
      payload        jsonb NOT NULL,
      "receivedAt"   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT incoming_payment_events_idem_key UNIQUE ("idemKey")
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS payments (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "incomingEventId" uuid NOT NULL REFERENCES incoming_payment_events (id),
      "subscriptionId" uuid,
      "externalUserId" text NOT NULL,
      amount           integer NOT NULL,
      currency         smallint NOT NULL,
      source           text NOT NULL,
      "occurredAt"     timestamptz NOT NULL,
      "createdAt"      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payments_incoming_event_key UNIQUE ("incomingEventId")
    )
  `,
];

const quarantineTables = (sql: SqlClient.SqlClient) => [
  sql`
    CREATE TABLE IF NOT EXISTS quarantine_records (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "incomingEventId"   uuid NOT NULL REFERENCES incoming_payment_events (id),
      status              text NOT NULL DEFAULT 'open',
      "boundSubscriptionId" uuid,
      "resolvedBy"        text,
      "resolvedAt"        timestamptz,
      "createdAt"         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT quarantine_records_incoming_event_key UNIQUE ("incomingEventId")
    )
  `,
  sql`CREATE INDEX IF NOT EXISTS quarantine_records_status_idx ON quarantine_records (status)`,
  sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor        text NOT NULL,
      action       text NOT NULL,
      "targetType" text NOT NULL,
      "targetId"   text NOT NULL,
      detail       jsonb,
      "occurredAt" timestamptz NOT NULL DEFAULT now()
    )
  `,
];

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all([...paymentTables(sql), ...quarantineTables(sql)], {
    discard: true,
  }),
);
