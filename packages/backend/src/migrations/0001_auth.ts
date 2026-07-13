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
 * Statements run in order (sessions references operators). Roles are `smallint`
 * (the numeric Role enum); secrets are stored hashed only — passwords as
 * argon2id, tokens/sessions as SHA-256.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS auth_tokens (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          alias        text NOT NULL,
          role         smallint NOT NULL,
          token_prefix text NOT NULL,
          token_hash   text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT auth_tokens_alias_key UNIQUE (alias),
          -- Bearer-token auth resolves a presented secret by its hash.
          CONSTRAINT auth_tokens_token_hash_key UNIQUE (token_hash)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS auth_tokens_token_prefix_idx
          ON auth_tokens (token_prefix)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS operators (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          login         text NOT NULL,
          role          smallint NOT NULL,
          password_hash text NOT NULL,
          created_at    timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT operators_login_key UNIQUE (login)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
          role        smallint NOT NULL,
          token_hash  text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          expires_at  timestamptz NOT NULL
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS sessions_operator_id_idx
          ON sessions (operator_id)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
          ON sessions (expires_at)
      `,
    ],
    { discard: true },
  ),
);
