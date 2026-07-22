import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { type Sink, type SinkKind } from '@billing-service/shared';
import { Effect, Option } from 'effect';

/**
 * Sink-config persistence (docs/21). One row per sink keyed on numeric `kind`;
 * `auth`/`config` are jsonb (stored via `${JSON.stringify(x)}::jsonb`, the outbox
 * pattern). Rows are the shared `Sink` DU — trusted on read (we own every write and
 * the PUT route validates operator input), matching the other repos. `*WithSecret`
 * reads include the auth token and are used ONLY by the sinks service + flows route,
 * never handed to the API read shape (which projects the token away).
 */
export interface SinksRepo {
  readonly listWithSecret: () => Effect.Effect<
    readonly Sink[],
    SqlError.SqlError
  >;
  readonly getWithSecret: (
    kind: SinkKind,
  ) => Effect.Effect<Option.Option<Sink>, SqlError.SqlError>;
  /** Whole-row upsert of a merged entity (the domain does the write-only merge). */
  readonly write: (sink: Sink) => Effect.Effect<void, SqlError.SqlError>;
}

const listWithSecret = (sql: SqlClient.SqlClient) => () =>
  sql<Sink>`
    SELECT kind, enabled, auth, config, "updatedAt" FROM sinks ORDER BY kind
  `;

const getWithSecret = (sql: SqlClient.SqlClient) => (kind: SinkKind) =>
  sql<Sink>`
    SELECT kind, enabled, auth, config, "updatedAt" FROM sinks WHERE kind = ${kind}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const write = (sql: SqlClient.SqlClient) => (sink: Sink) =>
  sql`
    INSERT INTO sinks (kind, enabled, auth, config, "updatedAt")
    VALUES (${sink.kind}, ${sink.enabled},
            ${JSON.stringify(sink.auth)}::jsonb, ${JSON.stringify(sink.config)}::jsonb, now())
    ON CONFLICT (kind) DO UPDATE
      SET enabled = EXCLUDED.enabled, auth = EXCLUDED.auth,
          config = EXCLUDED.config, "updatedAt" = now()
  `.pipe(Effect.asVoid);

export const makeSinksRepo = (sql: SqlClient.SqlClient): SinksRepo => ({
  listWithSecret: listWithSecret(sql),
  getWithSecret: getWithSecret(sql),
  write: write(sql),
});
