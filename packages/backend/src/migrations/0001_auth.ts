import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0001 — auth tables (the first real schema).
 *
 * `@effect/sql`'s file-system migrator loads `.ts`/`.js` modules whose default
 * export is an Effect (it does NOT execute `.sql` files), so the DDL lives here
 * as typed statements. Keeping it under `src/migrations` means tsc compiles it
 * into `dist/migrations` alongside everything else — the migrator resolves the
 * same relative dir for `tsx src/...` and `node dist/...`, so no copy step.
 *
 * Columns are the exact shared-schema field names (camelCase), double-quoted so
 * Postgres preserves the casing — a row is the entity shape verbatim, with no
 * name transform anywhere (single source of truth). Statements run in order
 * (sessions references operators). Roles are `smallint` (the numeric Role enum);
 * secrets are stored hashed only — passwords as argon2id, tokens as SHA-256.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS auth_tokens (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          alias         text NOT NULL,
          role          smallint NOT NULL,
          "tokenPrefix" text NOT NULL,
          "tokenHash"   text NOT NULL,
          "createdAt"   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT auth_tokens_alias_key UNIQUE (alias),
          -- Bearer-token auth resolves a presented secret by its hash.
          CONSTRAINT auth_tokens_token_hash_key UNIQUE ("tokenHash")
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS auth_tokens_token_prefix_idx
          ON auth_tokens ("tokenPrefix")
      `,
      sql`
        CREATE TABLE IF NOT EXISTS operators (
          id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          login          text NOT NULL,
          role           smallint NOT NULL,
          "passwordHash" text NOT NULL,
          "createdAt"    timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT operators_login_key UNIQUE (login)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "operatorId" uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
          role         smallint NOT NULL,
          "tokenHash"  text NOT NULL,
          "createdAt"  timestamptz NOT NULL DEFAULT now(),
          "expiresAt"  timestamptz NOT NULL
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS sessions_operator_id_idx
          ON sessions ("operatorId")
      `,
      sql`
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
          ON sessions ("expiresAt")
      `,
    ],
    { discard: true },
  ),
);
