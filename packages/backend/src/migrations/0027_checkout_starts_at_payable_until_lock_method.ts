import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0027 — `startsAt`, `payableUntil` and `lockMethod` on checkout sessions.
 *
 * `startsAt`: when the paid period of a subscription this checkout creates begins, if
 * later than the payment. `payableUntil`: the instant a bounded offer closes, after which
 * `/pay` refuses. Both nullable, with no default: NULL is "not declared", which is how
 * every existing row and every server-minted session behaves. `lockMethod`: the payer
 * cannot switch method; NOT NULL DEFAULT false, which is what every existing row means.
 * `firstSentToProviderAt`: when the session was first claimed for payment (its order handed
 * to a provider); stamped once, never cleared, so a later release cannot hide that a
 * payment may still land. NULL on existing rows, whose status and `claimedAt` still tell.
 *
 * The previous image keeps inserting valid rows during a rolling deploy: it omits all
 * four, and they take NULL / false. Each ADD COLUMN is catalog-only (no table rewrite):
 * the defaults are NULL or a constant. Rollback: `DELETE FROM effect_sql_migrations WHERE
 * migration_id = 27`; the columns may stay, the old image never reads them.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "startsAt" timestamptz`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "payableUntil" timestamptz`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "lockMethod" boolean NOT NULL DEFAULT false`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "firstSentToProviderAt" timestamptz`,
    ],
    { discard: true },
  ),
);
