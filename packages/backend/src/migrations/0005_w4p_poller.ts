import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0005 — WayForPay migration-poller state (docs/15 D2).
 *
 * One row per provider account: `watermark` is the epoch-seconds end of the last
 * window fully ingested. Each tick queries `[watermark - overlap, now]` and only
 * advances the watermark after all rows are durably enqueued, so a crash re-reads
 * the overlap (a no-op thanks to the queue's idempotency key).
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    CREATE TABLE IF NOT EXISTS w4p_poller_state (
      account     text PRIMARY KEY,
      watermark   bigint NOT NULL,
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )
  `.pipe(Effect.asVoid),
);
