import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0028 — card-check checkouts (`firstCharge`), the Closed session state, and the
 * defer revision.
 *
 * `checkout_sessions."firstCharge"` / `payments."firstCharge"`: `now` or `card_check`, NOT
 * NULL DEFAULT 'now', which is what every existing row is. `checkout_sessions."closedReason"`:
 * why a card-check session was closed (status 4); NULL otherwise. `payments."deferRevision"`:
 * incremented by every defer in the same UPDATE that moves the date, so a consumer orders
 * the defers of one payment by it, whatever order their notifications arrive in.
 * `payments."firstMoneyAt"` / `"firstMoneyRef"`: when, and by which provider order, the
 * payment first took money that credited a period; written once, in the transaction that
 * credits it (the scheduler's approval, a paid checkout, an arrears card change). A
 * handover defer refuses a payment that has it; the success of that order carries the
 * first-charge marker. The `charge_fixations("paymentId")` index serves the per-payment
 * fixation reads; `messages_receipt_ref` the revival of an order's receipts when the
 * scheduler's approval commits. `messages."failureCount"`: the ordinary failures of a
 * message, apart from its attempts, so a wait never spends the retry budget.
 *
 * Every ADD COLUMN is catalog-only (a constant or NULL default). The previous image keeps
 * writing valid rows during a rolling deploy: it omits all four and they take their
 * defaults. Forward-only: once a card-check session exists, no image older than the one
 * that ships this may run, and this migration is never reverted (a `now` default on a
 * reverted image would silently turn an issued card check into a full-price checkout).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "firstCharge" text NOT NULL DEFAULT 'now'`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "closedReason" text`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "firstCharge" text NOT NULL DEFAULT 'now'`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "deferRevision" integer NOT NULL DEFAULT 0`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "firstMoneyAt" timestamptz`,
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "firstMoneyRef" text`,
      sql`CREATE INDEX IF NOT EXISTS charge_fixations_payment_id ON charge_fixations ("paymentId")`,
      sql`CREATE INDEX IF NOT EXISTS messages_receipt_ref ON messages ((payload->>'externalRef')) WHERE "messageType" = 'payment_event_received'`,
      sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS "failureCount" int NOT NULL DEFAULT 0`,
      // The receipt sweep's selection: approvals oldest first, and their charges by order.
      sql`CREATE INDEX IF NOT EXISTS idempotency_keys_advance_created ON idempotency_keys ("createdAt") WHERE scope = 'scheduler.advance'`,
      sql`CREATE INDEX IF NOT EXISTS charges_external_ref ON charges ("externalRef")`,
      // A message retrying when this runs failed on every attempt so far (waiting did not
      // exist): its budget carries on where it was.
      sql`UPDATE messages SET "failureCount" = "attemptCount" WHERE status = 'retry' AND "failureCount" = 0`,
    ],
    { discard: true },
  ),
);
