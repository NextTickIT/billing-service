import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0026 — `migration` checkout origin, and the `claimedAt` column.
 *
 * `checkout_sessions_origin_check` gains a fifth value, `'migration'` (a caller-created
 * checkout sent with `reportAs: "renewal"`: a legacy payer migrating in, whose outcome
 * reports `recurring_*`), and `checkout_sessions` gains a nullable `"claimedAt"` (when
 * the buyer last pressed Pay, `claimForPayment`; NULL when never claimed or released).
 *
 * The CHECK is replaced, not altered: Postgres cannot edit a CHECK in place. A `DO`
 * guard first fails the migration with `unexpected origin CHECK on checkout_sessions`
 * unless exactly one CHECK whose `conkey` is exactly the `origin` column exists and it
 * is named `checkout_sessions_origin_check`. The guard turns a hand-edited schema into
 * a loud, atomic failure instead of a silently dropped or duplicated constraint.
 *
 * `lock_timeout` bounds lock ACQUISITION only, so a busy table fails the boot fast.
 * `statement_timeout` bounds the ADD CONSTRAINT validation scan, which holds ACCESS
 * EXCLUSIVE until commit. The migrator runs every pending migration and its ledger
 * insert in one transaction, which `SET LOCAL` is scoped to, and a RAISE in the guard
 * leaves no ledger row 26.
 *
 * Deploy and rollback:
 * - The old image keeps running while this applies, because it never writes
 *   `'migration'`.
 * - Once applied, the server and migration entrypoints of an image without this file
 *   refuse to start: `main.ts` and `db-migrate.ts` both call `runMigrations`, which
 *   runs `assertAppliedMatchFiles`. That includes the old server container if it
 *   restarts before the new image is up. A standalone worker (`worker.ts`) applies no
 *   migrations and is not refused.
 * - Rollback: `DELETE FROM effect_sql_migrations WHERE migration_id = 26`. The widened
 *   CHECK and the column may stay. Restoring the 4-value CHECK first needs
 *   `UPDATE checkout_sessions SET origin = NULL WHERE origin = 'migration'`.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      // Bounds lock acquisition only (fail fast if the table is busy).
      sql`SET LOCAL lock_timeout = '5s'`,
      // Bounds the ADD CONSTRAINT validation scan, which holds ACCESS EXCLUSIVE until
      // commit; prod's checkout_sessions is a few thousand rows (ms), 60s only caps a
      // pathological case.
      sql`SET LOCAL statement_timeout = '60s'`,
      sql`
        DO $$
        DECLARE n int; nm text;
        BEGIN
          SELECT count(*), min(c.conname) INTO n, nm
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'origin'
          WHERE c.conrelid = 'checkout_sessions'::regclass AND c.contype = 'c'
            AND c.conkey = ARRAY[a.attnum]::int2[];
          IF n <> 1 OR nm <> 'checkout_sessions_origin_check' THEN
            RAISE EXCEPTION 'unexpected origin CHECK on checkout_sessions: % constraint(s), first %', n, nm;
          END IF;
        END $$
      `,
      sql`ALTER TABLE checkout_sessions DROP CONSTRAINT checkout_sessions_origin_check`,
      sql`
        ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_origin_check
          CHECK (origin IN ('prolong', 'manual_renewal', 'card_change', 'card_change_arrears', 'migration'))
      `,
      // When the buyer last pressed Pay (claimForPayment); NULL when never claimed or released.
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "claimedAt" timestamptz`,
    ],
    { discard: true },
  ).pipe(Effect.asVoid),
);
