import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0010 — drift-free date model (docs/19 §3, AC-7/8).
 *
 * Adds `currentPeriodStart` / `currentPeriodEnd` as the period anchor columns
 * and renames `nextChargeDate` → `nextPaymentDate` to match the spec vocabulary.
 *
 * Backfill is STATUS-BRANCHED (F-A fix) — a naïve `currentPeriodEnd = nextPaymentDate`
 * would bake in drift for past_due rows where `nextPaymentDate` is the retry date,
 * not the original due date:
 *   active (0)        → anchor = nextPaymentDate (on-schedule rows are already correct)
 *   past_due (1)      → anchor = firstFailureAt  (day-0 due date, before retry offset)
 *   terminal (2 / 3)  → anchor = COALESCE(firstFailureAt, nextPaymentDate)
 *   currentPeriodStart = anchor − period in all cases (approximate for existing rows;
 *   exact for rows created/extended after this migration).
 *
 * No data is dropped; no replay is harmed (P1, AC-6).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      // Step 1: add the two new anchor columns (nullable for backfill).
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "currentPeriodStart" timestamptz`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "currentPeriodEnd"   timestamptz`,

      // Step 2: rename the scheduling column to match the spec vocabulary.
      sql`ALTER TABLE payments RENAME COLUMN "nextChargeDate" TO "nextPaymentDate"`,

      // Step 3: status-branched backfill.
      sql`
        UPDATE payments SET
          "currentPeriodEnd" = CASE
            WHEN status = 1 THEN "firstFailureAt"
            ELSE COALESCE("firstFailureAt", "nextPaymentDate")
          END
        WHERE status IN (1, 2, 3)
      `,
      sql`
        UPDATE payments SET
          "currentPeriodEnd" = "nextPaymentDate"
        WHERE status = 0
      `,
      // currentPeriodStart is derived from the anchor and the stored period string.
      // ISO-8601 interval arithmetic: period − 1 month ≈ subtract the interval.
      sql`
        UPDATE payments SET
          "currentPeriodStart" = "currentPeriodEnd" - period::interval
      `,

      // Step 4: make the columns non-nullable now that every row has a value.
      sql`ALTER TABLE payments ALTER COLUMN "currentPeriodStart" SET NOT NULL`,
      sql`ALTER TABLE payments ALTER COLUMN "currentPeriodEnd"   SET NOT NULL`,

      // Step 5: drop the old index (references the old column name) and recreate.
      sql`DROP INDEX IF EXISTS payments_due_idx`,
      sql`
        CREATE INDEX payments_due_idx
          ON payments ("nextPaymentDate") WHERE status IN (0, 1)
      `,
    ],
    { discard: true },
  ),
);
