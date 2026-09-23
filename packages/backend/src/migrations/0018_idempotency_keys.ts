import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0018 — a general idempotency ledger for mutating endpoints.
 *
 * Some operator actions create or additively change state (create a payment, defer a
 * payment) and so are NOT naturally idempotent: a retried or double-submitted request
 * would apply twice (a duplicate payment, a second grant of free days). This table lets
 * such an endpoint dedup on a caller-supplied `Idempotency-Key`: the first request under
 * a (scope, idemKey) records its response, and a repeat replays that response instead of
 * re-running. `scope` namespaces the key per operation so one caller key can't collide
 * across endpoints. `response` is null only for the brief in-flight window inside the
 * writing transaction; a committed row always carries it.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      scope       text        NOT NULL,
      "idemKey"   text        NOT NULL,
      response    jsonb,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, "idemKey")
    )
  `.pipe(Effect.asVoid),
);
