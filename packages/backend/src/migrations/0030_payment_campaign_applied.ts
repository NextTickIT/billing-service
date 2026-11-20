import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0030 — `payments."campaignApplied"`: the durable "applied" marker of a paid
 * campaign payment (`POST /api/payment/apply-offer`). NULL until applied; then
 * `{buyerId, externalUserId, result, paymentId, periodEnd, nextPaymentDate, …}`, so the
 * payment is applied once and a repeated apply answers what the first one did.
 *
 * Catalog-only ADD COLUMN (NULL default), so the previous image keeps writing valid rows.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS "campaignApplied" jsonb`.pipe(
    Effect.asVoid,
  ),
);
