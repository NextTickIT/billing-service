import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0012 — soft-cancel grace flag (docs/23/24).
 *
 * `cancelRequestedAt` is set when an operator soft-cancels: the payment stays
 * `active` (access runs to `currentPeriodEnd`) and the scheduler lapses it at the
 * due date instead of charging. Null in normal operation, so existing rows need
 * no backfill.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "cancelRequestedAt" timestamptz`.pipe(
    Effect.asVoid,
  ),
);
