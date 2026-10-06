import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/**
 * Migration 0020 — separate an event's IDENTITY from its DEDUPE SURFACE (docs/07).
 *
 * `domain_events.id` is what a sink reads as `event_id`, and live SendPulse flows branch
 * on it, so its format cannot change without coordinating every consumer. Dedupe moves to
 * its own column instead: `idempotencyKey` is what a consumer (and, a release from now,
 * this table's own constraint) collapses repeats on, leaving `id` free to mean identity.
 *
 * STAGED DELIBERATELY. This release only adds the column, backfills it from `id`, and
 * starts populating it on write; the insert still conflicts on `(id)`. The unique index
 * and the `ON CONFLICT` switch come in a LATER release, for two reasons:
 *
 *   1. During a rolling deploy the previous image is still inserting rows with no
 *      `idempotencyKey`. A NOT NULL or a unique index now would make those inserts fail.
 *   2. A unique index on this column while the insert still says `ON CONFLICT (id)` turns
 *      a duplicate key into a raised unique violation instead of a swallowed no-op —
 *      a publish would crash where today it correctly does nothing.
 *
 * So the column is nullable with no default, and readers coalesce to `id`. The index here
 * is deliberately NON-unique: it makes the later `CREATE UNIQUE INDEX CONCURRENTLY` cheap
 * without yet enforcing anything.
 */
export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.all(
    [
      sql`
        ALTER TABLE domain_events
          ADD COLUMN IF NOT EXISTS "idempotencyKey" text
      `,
      // Backfill: every historical event's dedupe surface IS the id it deduped on, so the
      // column is true for the whole table from the moment it exists.
      sql`
        UPDATE domain_events
        SET "idempotencyKey" = id
        WHERE "idempotencyKey" IS NULL
      `,
      sql`
        CREATE INDEX IF NOT EXISTS domain_events_idempotency_key_idx
          ON domain_events ("idempotencyKey")
      `,
    ],
    { discard: true },
  ),
);
