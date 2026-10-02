import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0022 — seed the CRM sink row (docs/21).
 *
 * `kind = 1`, DISABLED, with an empty URL and an empty token. The sinks table was built so
 * that a new sink is a new row and no schema change (AC8), so this is the whole of it.
 *
 * Seeded off deliberately. The moment the row is enabled the outbox starts creating a CRM
 * delivery for every event, and a row enabled before the operator has pasted an endpoint
 * would mean one dead-lettered delivery per event. Off-with-no-URL is the only state that
 * is safe to ship ahead of the CRM being ready to receive.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    INSERT INTO sinks (kind, enabled, auth, config)
    VALUES (1, false, '{"kind":0,"token":""}'::jsonb, '{"url":""}'::jsonb)
    ON CONFLICT (kind) DO NOTHING
  `.pipe(Effect.asVoid),
);
