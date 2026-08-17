import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0013 — card-change checkout sessions (docs/23/24).
 *
 * `kind` discriminates a normal checkout (0) from a card-change session (1); the
 * callback routes on it. `paymentId` links a card-change session to the payment it
 * re-tokenizes. Existing sessions default to `kind = 0` / null, so no backfill.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS kind integer NOT NULL DEFAULT 0`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "paymentId" text`,
    ],
    { discard: true },
  ),
);
