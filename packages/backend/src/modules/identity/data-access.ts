import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  ExternalUserIdChange,
  type NewExternalUserIdChange,
} from '@billing-service/shared';
import { Effect } from 'effect';

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

export const makeExternalUserIdChangeRepo = (
  sql: SqlClient.SqlClient,
): ExternalUserIdChangeRepo => ({
  append: append(sql),
});
