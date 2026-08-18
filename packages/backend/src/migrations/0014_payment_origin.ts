import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0014 — legacy payment import (docs/25). `payments.origin` marks where a
 * Payment's billing lives (`0 = managed`, our WayForPay checkout; `1 = external`, a
 * user charged on SendPulse's own merchant, imported read-only). It defaults to
 * `managed`, so every existing row and every checkout-created Payment stays managed
 * with no backfill; only the legacy import writes `external`.
 *
 * `legacy_sync_state` is the per-source watermark for the import: a full backfill on
 * the first run, then incremental syncs that read only the history since `watermark`
 * (mirrors `w4p_poller_state`).
 *
 * `payments_one_external_per_user` gives the import a stable upsert target — one
 * `external` Payment per `externalUserId` — so a re-import updates that row instead of
 * inserting a duplicate. It is disjoint from `payments_one_active_per_user`
 * (`WHERE status = 0`): a superseded (`Cancelled`) external row still occupies this
 * external slot but frees the active one for the migrated managed Payment.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS origin smallint NOT NULL DEFAULT 0`,
      sql`
        CREATE UNIQUE INDEX IF NOT EXISTS payments_one_external_per_user
          ON payments ("externalUserId") WHERE origin = 1
      `,
      sql`
        CREATE TABLE IF NOT EXISTS legacy_sync_state (
          source      text PRIMARY KEY,
          watermark   timestamptz NOT NULL,
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )
      `,
    ],
    { discard: true },
  ),
);
