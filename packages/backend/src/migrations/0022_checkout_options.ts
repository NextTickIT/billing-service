import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0022 — checkout options.
 *
 * `checkout_sessions` gains `options` (jsonb, same serialization as `promo`/`renewal`):
 * the options the payer picks from on the page — caller options
 * `[{"amount":5000,"period":"P4W"}, …]` or manual-renewal cycles `[{"cycles":1}, …]`.
 * NULL offers the flat terms alone, which is every row minted before this migration.
 *
 * `lock_timeout` is first so a blocked ALTER fails the boot fast instead of stalling it
 * (see 0021). Additive and nullable — the previous image keeps reading and writing rows
 * while this is applied.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`SET LOCAL lock_timeout = '5s'`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS options jsonb`,
    ],
    { discard: true },
  ).pipe(Effect.asVoid),
);
