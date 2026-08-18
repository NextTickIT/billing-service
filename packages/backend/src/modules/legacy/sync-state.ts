import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect, Option } from 'effect';

/**
 * Legacy-import watermark persistence (docs/25 §4.1), mirroring
 * `w4p_poller_state`. The watermark is the newest SendPulse `createdAt` already
 * imported; `upsert` advances it only after a pass completes, so a re-run is a safe
 * incremental (and, with no row yet, a full backfill). Keyed by `source` so a future
 * legacy feed gets its own watermark.
 */
export interface LegacySyncStateRepo {
  readonly getWatermark: (
    source: string,
  ) => Effect.Effect<Option.Option<Date>, SqlError.SqlError>;
  readonly upsertWatermark: (
    source: string,
    watermark: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const getWatermark = (sql: SqlClient.SqlClient) => (source: string) =>
  sql<{ readonly watermark: Date }>`
    SELECT watermark FROM legacy_sync_state WHERE source = ${source}
  `.pipe(
    Effect.map((rows) => Option.fromNullable(rows[0])),
    Effect.map(Option.map((row) => row.watermark)),
  );

const upsertWatermark =
  (sql: SqlClient.SqlClient) => (source: string, watermark: Date) =>
    sql`
      INSERT INTO legacy_sync_state (source, watermark, "updatedAt")
      VALUES (${source}, ${watermark}, now())
      ON CONFLICT (source)
      DO UPDATE SET watermark = ${watermark}, "updatedAt" = now()
    `.pipe(Effect.asVoid);

export const makeLegacySyncStateRepo = (
  sql: SqlClient.SqlClient,
): LegacySyncStateRepo => ({
  getWatermark: getWatermark(sql),
  upsertWatermark: upsertWatermark(sql),
});
