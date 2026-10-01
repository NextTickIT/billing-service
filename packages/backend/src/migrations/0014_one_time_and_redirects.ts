import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0014 — one-time payments + post-payment redirect URLs.
 *
 * 1. `payments.recurring` / `checkout_sessions.recurring` (default true): a one-time
 *    payment (`false`) is created fresh per charge, holds no reusable token, and is
 *    never scheduled. Existing rows are subscriptions, so the default backfills them.
 * 2. The one-active-per-user unique index and the scheduler's due index are narrowed
 *    to `recurring` rows: a user may hold one active recurring payment AND any number
 *    of one-time payments, and the scheduler only ever claims recurring rows.
 * 3. `checkout_sessions.successUrl` / `failureUrl` (nullable): where the return page
 *    sends the browser once the webhook resolves the payment.
 *
 * No columns are dropped; no data is lost (P1, AC-6).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS recurring boolean NOT NULL DEFAULT true`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS recurring boolean NOT NULL DEFAULT true`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "successUrl" text`,
      sql`ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS "failureUrl" text`,

      // Narrow "one active per user" to recurring rows: a one-time active payment no
      // longer blocks a second one, nor coexisting with an active recurring payment.
      sql`DROP INDEX IF EXISTS payments_one_active_per_user`,
      sql`
        CREATE UNIQUE INDEX payments_one_active_per_user
          ON payments ("externalUserId") WHERE status = 0 AND recurring
      `,

      // The scheduler only ever charges recurring payments; keep them alone in its index.
      sql`DROP INDEX IF EXISTS payments_due_idx`,
      sql`
        CREATE INDEX payments_due_idx
          ON payments ("nextPaymentDate") WHERE status IN (0, 1) AND recurring
      `,
    ],
    { discard: true },
  ),
);
