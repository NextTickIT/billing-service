import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0009 — rename the payment-lifecycle tables (docs/19 §2).
 *
 * 1. `payments` (charge fixation table from 0004) → `charge_fixations`: a row
 *    here is the record of a charge being fixed to a gateway payment, not the
 *    payment itself. The unique index and the `subscriptionId` FK-less column are
 *    renamed to match.
 * 2. `subscriptions` → `payments`: the entity that owns the billing lifecycle is
 *    now called Payment, not Subscription. Indexes renamed accordingly.
 * 3. `quarantine_records."boundSubscriptionId"` → `"boundPaymentId"`: the column
 *    that links a resolved quarantine to the payment it was bound to.
 *
 * No columns are dropped; no data is lost (P1, AC-6).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      // Step 1: rename the old fixation table and its artifacts.
      sql`ALTER TABLE payments RENAME TO charge_fixations`,
      sql`ALTER TABLE charge_fixations RENAME COLUMN "subscriptionId" TO "paymentId"`,
      sql`ALTER TABLE charge_fixations RENAME CONSTRAINT payments_incoming_event_key TO charge_fixations_incoming_event_key`,

      // Step 2: rename the subscription lifecycle table and its indexes.
      sql`ALTER TABLE subscriptions RENAME TO payments`,
      sql`ALTER INDEX subscriptions_one_active_per_user RENAME TO payments_one_active_per_user`,
      sql`ALTER INDEX subscriptions_due_idx RENAME TO payments_due_idx`,

      // Step 3: rename the quarantine back-reference column.
      sql`ALTER TABLE quarantine_records RENAME COLUMN "boundSubscriptionId" TO "boundPaymentId"`,
    ],
    { discard: true },
  ),
);
