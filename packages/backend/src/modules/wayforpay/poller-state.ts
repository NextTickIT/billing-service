import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect, Option } from 'effect';

/**
 * Poller watermark persistence (docs/15 D2). The watermark is epoch seconds of the
 * last fully-ingested window end; `upsert` advances it only after ingest, so it is
 * safe to re-read on restart.
 */
export interface PollerStateRepo {
  readonly getWatermark: (
    account: string,
  ) => Effect.Effect<Option.Option<number>, SqlError.SqlError>;
  readonly upsertWatermark: (
    account: string,
    watermark: number,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const getWatermark = (sql: SqlClient.SqlClient) => (account: string) =>
  sql<{ readonly watermark: string }>`
    SELECT watermark FROM w4p_poller_state WHERE account = ${account}
  `.pipe(
    Effect.map((rows) => Option.fromNullable(rows[0])),
    Effect.map(Option.map((row) => Number(row.watermark))),
  );

const upsertWatermark =
  (sql: SqlClient.SqlClient) => (account: string, watermark: number) =>
    sql`
      INSERT INTO w4p_poller_state (account, watermark, "updatedAt")
      VALUES (${account}, ${watermark}, now())
      ON CONFLICT (account)
      DO UPDATE SET watermark = ${watermark}, "updatedAt" = now()
    `.pipe(Effect.asVoid);

export const makePollerStateRepo = (
  sql: SqlClient.SqlClient,
): PollerStateRepo => ({
  getWatermark: getWatermark(sql),
  upsertWatermark: upsertWatermark(sql),
});
