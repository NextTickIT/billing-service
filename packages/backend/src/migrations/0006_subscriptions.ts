import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0006 — gateway subscriptions (docs/05, FR-003/004). Columns mirror the
 * shared Subscription shape verbatim (camelCase, double-quoted). The recurring
 * token reference is stored inline (`recurringTokenRef`): a subscription owns at
 * most one provider token. A partial unique index enforces the interview decision
 * of at most one ACTIVE subscription per external user (status 0 = active).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "externalUserId"    text NOT NULL,
          amount              integer NOT NULL,
          currency            smallint NOT NULL,
          method              smallint NOT NULL,
          period              text NOT NULL,
          status              smallint NOT NULL,
          "nextChargeDate"    timestamptz NOT NULL,
          "recurringTokenRef" text,
          "firstFailureAt"    timestamptz,
          "retryAttempt"      integer NOT NULL DEFAULT 0,
          "createdAt"         timestamptz NOT NULL DEFAULT now(),
          "updatedAt"         timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user
          ON subscriptions ("externalUserId") WHERE status = 0
      `,
      // The scheduler (FR-004) claims due subscriptions by this index.
      sql`
        CREATE INDEX IF NOT EXISTS subscriptions_due_idx
          ON subscriptions ("nextChargeDate") WHERE status IN (0, 1)
      `,
    ],
    { discard: true },
  ),
);
