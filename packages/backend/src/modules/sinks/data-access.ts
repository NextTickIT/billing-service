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
  /**
   * The payer's email for a receipt, best source first: the payment (carried from the
   * checkout that paid for it), then any checkout session that captured one, then the
   * SendPulse contact cache for legacy rows backfilled there. `None` means nothing is
   * on file — the caller must treat that as a failure to surface, never a silent skip,
   * because it means capture is broken for someone who has already paid.
   */
  readonly findEmail: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<string>, SqlError.SqlError>;
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

/**
 * `contacts.email` is the ONE source here that was never validated on write: the
 * contacts sync copies a SendPulse contact variable, which is free text the buyer typed
 * at a bot prompt, straight into the column. The other two paths are schema-checked at
 * the boundary. So the shape is enforced here, on read, for every branch — an address
 * that cannot be one is treated as absent rather than handed to the mail API as a
 * recipient.
 */
const EMAIL_SHAPE = '^[^[:space:]@]+@[^[:space:]@.]+\\.[^[:space:]@]{2,}$';

const findEmail = (sql: SqlClient.SqlClient) => (externalUserId: string) =>
  sql<{ readonly email: string }>`
    SELECT email FROM (
      SELECT email, 1 AS pri, "createdAt" AS at FROM payments
        WHERE "externalUserId" = ${externalUserId} AND email ~ ${EMAIL_SHAPE}
      UNION ALL
      SELECT email, 2 AS pri, "createdAt" AS at FROM checkout_sessions
        WHERE "externalUserId" = ${externalUserId} AND email ~ ${EMAIL_SHAPE}
      UNION ALL
      SELECT email, 3 AS pri, "updatedAt" AS at FROM contacts
        WHERE "externalUserId" = ${externalUserId} AND email ~ ${EMAIL_SHAPE}
    ) q
    ORDER BY pri, at DESC
    LIMIT 1
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0]?.email)));

export const makeSinksRepo = (sql: SqlClient.SqlClient): SinksRepo => ({
  listWithSecret: listWithSecret(sql),
  getWithSecret: getWithSecret(sql),
  write: write(sql),
  findEmail: findEmail(sql),
});
