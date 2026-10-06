import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0021 — caller `metadata` passthrough (docs/07).
 *
 * An opaque jsonb the external system attaches to a checkout and we hand back on every
 * event that checkout's payment produces. Billing never reads it, so there is no shape to
 * constrain and no default worth inventing: NULL means "nobody ever declared one", which
 * is distinct from `{}` ("declared, and empty") — a distinction the write path relies on
 * to tell "leave it alone" from "replace it".
 *
 * Nullable on both tables, so the previous image keeps inserting valid rows throughout a
 * rolling deploy. No index: nothing queries by it, and nothing should.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        ALTER TABLE checkout_sessions
          ADD COLUMN IF NOT EXISTS metadata jsonb
      `,
      sql`
        ALTER TABLE payments
          ADD COLUMN IF NOT EXISTS metadata jsonb
      `,
    ],
    { discard: true },
  ),
);
