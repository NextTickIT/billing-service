import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0015 — external-user-id remap history (docs/31).
 *
 * Append-only ledger: each `rename-external-user` action appends one row recording the
 * old id, the new id, who initiated it, and how many live records moved. It is the
 * durable history of every id change (AC-3 spirit: the change is auditable and the id
 * chain replayable). Columns mirror the shared `ExternalUserIdChange` shape verbatim.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS external_user_id_changes (
          id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "fromExternalUserId" text NOT NULL,
          "toExternalUserId"   text NOT NULL,
          source               text NOT NULL,
          reason               text,
          "movedPayments"      integer NOT NULL,
          "movedSessions"      integer NOT NULL,
          "occurredAt"         timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS external_user_id_changes_from_idx
          ON external_user_id_changes ("fromExternalUserId")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS external_user_id_changes_to_idx
          ON external_user_id_changes ("toExternalUserId")
      `,
    ],
    { discard: true },
  ),
);
