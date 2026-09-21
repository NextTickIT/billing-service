import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0019 — contact name cache (operator search). SendPulse has no
 * server-side name search, so a background sync (worker) mirrors each payment
 * contact's name/username/email/phone here, keyed on the SendPulse contact id
 * (= `payments."externalUserId"`). The operator's payments search resolves a
 * typed name to matching contact ids against this cache (instant, no live API
 * call in the request path). Purely a cache — safe to drop and re-sync.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    CREATE TABLE IF NOT EXISTS contacts (
      "externalUserId" text        PRIMARY KEY,
      name             text        NOT NULL DEFAULT '',
      username         text        NOT NULL DEFAULT '',
      email            text        NOT NULL DEFAULT '',
      phone            text        NOT NULL DEFAULT '',
      "updatedAt"      timestamptz NOT NULL DEFAULT now()
    )
  `.pipe(Effect.asVoid),
);
