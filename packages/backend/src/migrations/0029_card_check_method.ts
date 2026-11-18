import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0029 — the card-check method and the refund a `charge_refund` check owes.
 *
 * `checkout_sessions."cardCheckMethod"`: `lookup` (the 0 UAH Card Verify) or
 * `charge_refund` (a small Purchase billing refunds), NOT NULL DEFAULT 'lookup', which is
 * what every existing row is. `"verifyRefundState"`: NULL while no refund is owed;
 * `pending` once an approved verify charge enqueued its refund; `in_flight` while one
 * worker owns a REFUND call (`"verifyRefundClaimedAt"` bounds that ownership, so a
 * redelivery waits instead of sending a second REFUND); then `refunded` or `failed`.
 * `"verifyRefundedAt"`: when the refund was confirmed. `"verifyRefundAttempts"`: REFUND
 * attempts claimed, the one retry budget, kept across restarts.
 *
 * Every ADD COLUMN is catalog-only (a constant or NULL default), so the previous image
 * keeps writing valid rows during a rolling deploy. Forward-only, like 0028: an older
 * image would hand a `charge_refund` session the 0 UAH verify form.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "cardCheckMethod" text NOT NULL DEFAULT 'lookup'`,
      sql`ALTER TABLE checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_card_check_method`,
      sql`ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_card_check_method CHECK ("cardCheckMethod" IN ('lookup', 'charge_refund'))`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "verifyRefundState" text`,
      sql`ALTER TABLE checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_verify_refund_state`,
      sql`ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_verify_refund_state CHECK ("verifyRefundState" IN ('pending', 'in_flight', 'refunded', 'failed'))`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "verifyRefundClaimedAt" timestamptz`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "verifyRefundedAt" timestamptz`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "verifyRefundAttempts" integer NOT NULL DEFAULT 0`,
    ],
    { discard: true },
  ),
);
