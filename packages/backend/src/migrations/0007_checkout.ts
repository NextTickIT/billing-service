import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0007 — checkout sessions (docs/05, FR-001/002). The session id is an
 * app-minted unguessable `chk_…` token used both as the public link id and as the
 * WayForPay `orderReference`, so the callback matches straight back to it. `method`
 * is null until the user chooses one on the page. status 0=created 1=pending
 * 2=completed 3=expired.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    CREATE TABLE IF NOT EXISTS checkout_sessions (
      id               text PRIMARY KEY,
      "externalUserId" text NOT NULL,
      amount           integer NOT NULL,
      currency         smallint NOT NULL,
      period           text NOT NULL,
      method           smallint,
      status           smallint NOT NULL DEFAULT 0,
      "expiresAt"      timestamptz NOT NULL,
      "createdAt"      timestamptz NOT NULL DEFAULT now()
    )
  `.pipe(Effect.asVoid),
);
