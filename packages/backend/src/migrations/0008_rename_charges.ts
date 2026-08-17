import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0008 — rename the incoming-charge pipeline tables (docs/19 §2).
 *
 * `incoming_payment_events` → `charges`: each observed provider event is a Charge,
 * not a generic "payment event". The constraint and index names are updated to match
 * the new table name. No columns are dropped; no data is lost (P1, AC-6).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE incoming_payment_events RENAME TO charges`,
      sql`ALTER TABLE charges RENAME CONSTRAINT incoming_payment_events_idem_key TO charges_idem_key`,
    ],
    { discard: true },
  ),
);
