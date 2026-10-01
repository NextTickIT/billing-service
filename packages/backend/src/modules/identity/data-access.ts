import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  ExternalUserIdChange,
  type NewExternalUserIdChange,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import { columnList } from '@/infra/db/columns.js';
import { requireRow } from '@/infra/db/rows.js';

/**
 * The external-user-id remap ledger (docs/31): append-only history of every id change.
 * Same `(sql) => (input)` shape as the other repos; columns are the shared field names
 * verbatim.
 */
export interface ExternalUserIdChangeRepo {
  readonly append: (
    input: NewExternalUserIdChange,
  ) => Effect.Effect<ExternalUserIdChange, SqlError.SqlError>;
  /**
   * The most recent recorded remap of `from` → `to`, if any — the basis for an
   * idempotent retry: a repeated rename whose source id is already emptied replays this
   * result instead of failing NotFound.
   */
  readonly findLatestChange: (
    from: string,
    to: string,
  ) => Effect.Effect<Option.Option<ExternalUserIdChange>, SqlError.SqlError>;
}

const COLUMNS = columnList(ExternalUserIdChange.fields);

const append = (sql: SqlClient.SqlClient) => (input: NewExternalUserIdChange) =>
  sql<ExternalUserIdChange>`
      INSERT INTO external_user_id_changes
        ("fromExternalUserId", "toExternalUserId", source, reason,
         "movedPayments", "movedSessions")
      VALUES
        (${input.fromExternalUserId}, ${input.toExternalUserId}, ${input.source},
         ${input.reason}, ${input.movedPayments}, ${input.movedSessions})
      RETURNING ${sql.unsafe(COLUMNS)}
    `.pipe(Effect.flatMap(requireRow));

const findLatestChange =
  (sql: SqlClient.SqlClient) => (from: string, to: string) =>
    sql<ExternalUserIdChange>`
      SELECT ${sql.unsafe(COLUMNS)} FROM external_user_id_changes
      WHERE "fromExternalUserId" = ${from} AND "toExternalUserId" = ${to}
      ORDER BY "occurredAt" DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

export const makeExternalUserIdChangeRepo = (
  sql: SqlClient.SqlClient,
): ExternalUserIdChangeRepo => ({
  append: append(sql),
  findLatestChange: findLatestChange(sql),
});
