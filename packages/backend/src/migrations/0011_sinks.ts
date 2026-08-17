import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0011 — sink configuration (docs/21). One row per sink, keyed on the
 * numeric `SinkKind` (`0 = sendpulse`). `auth` and `config` are jsonb discriminated
 * unions so a new sink is a new row, no schema change (AC8). `auth` carries the
 * write-only secret (redacted at every log site); `config` is sink-specific
 * (SendPulse: `{ "flows": { "<event>": "<flowId>" } }`). The stable string code
 * ('sendpulse') is derived from `kind` in the shared schema, so `event_deliveries`
 * is untouched. Seeds a disabled sendpulse row so the operator can configure it.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        CREATE TABLE IF NOT EXISTS sinks (
          kind        smallint PRIMARY KEY,
          enabled     boolean     NOT NULL DEFAULT false,
          auth        jsonb       NOT NULL DEFAULT '{"kind":0,"token":""}'::jsonb,
          config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )
      `,
      sql`
        INSERT INTO sinks (kind, enabled, auth, config)
        VALUES (0, false, '{"kind":0,"token":""}'::jsonb, '{"flows":{}}'::jsonb)
        ON CONFLICT (kind) DO NOTHING
      `,
    ],
    { discard: true },
  ),
);
