import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0016 — optional one-time checkout promo.
 *
 * `checkout_sessions.promo` (nullable jsonb): an optional promo the caller attaches at
 * session creation, e.g. `{"additionalFreePeriod":"P14D"}`. When the session is paid it
 * pushes the payment's paid-through anchor (and the derived next charge date) further by
 * that ISO-8601 duration, once. Null (no promo) for every existing and most new rows;
 * never re-applied on recurring renewals.
 *
 * Additive and nullable — no columns dropped, no data lost.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS promo jsonb`.pipe(
    Effect.asVoid,
  ),
);
