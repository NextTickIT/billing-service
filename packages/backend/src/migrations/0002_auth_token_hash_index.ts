import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0002 — index auth_tokens by token_hash.
 *
 * Bearer-token authentication resolves a presented `bst_` secret by its SHA-256
 * hash on every admin request, so the lookup needs an index; UNIQUE also asserts
 * that stored token hashes never collide.
 */
export default Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`
      CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_token_hash_key
        ON auth_tokens (token_hash)
    `,
);
