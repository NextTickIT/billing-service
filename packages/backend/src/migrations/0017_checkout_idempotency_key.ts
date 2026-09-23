import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0017 — opt-in idempotency key for checkout-session creation.
 *
 * `checkout_sessions.idempotencyKey` (nullable text): the caller's `Idempotency-Key`
 * header, stored so a retried or parallel `POST /api/checkout-sessions` collapses to a
 * single session instead of minting duplicates (which otherwise cascade into duplicate
 * WayForPay/WhitePay flows). The partial unique index enforces one session per key while
 * leaving key-less sessions (the common case, NULL) unconstrained — Postgres treats NULLs
 * as distinct, and the WHERE makes that explicit. INSERT … ON CONFLICT DO NOTHING keys on
 * this index, so concurrent creates with one key serialize to a single winner.
 *
 * Additive and nullable — no columns dropped, no data lost.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "idempotencyKey" text`,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS checkout_sessions_idempotency_key
          ON checkout_sessions ("idempotencyKey")
          WHERE "idempotencyKey" IS NOT NULL
      `,
    ],
    { discard: true },
  ),
);
