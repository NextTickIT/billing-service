import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect } from 'effect';

import type { ContactProfile } from '@/modules/sinks/sendpulse.js';

/**
 * The contact name cache (migration 0019). One row per SendPulse contact id
 * (= `payments."externalUserId"`), kept fresh by the worker's contacts sync so
 * the operator's payments search can resolve a typed name to contact ids in a
 * single SQL query — SendPulse has no server-side name search.
 */
export interface ContactsRepo {
  readonly upsert: (
    externalUserId: string,
    profile: ContactProfile,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /**
   * Distinct payment contact ids whose cache row is missing or older than
   * `ttlSeconds` — the sync's work-list. Capped at `limit`.
   */
  readonly staleContactIds: (
    ttlSeconds: number,
    limit: number,
  ) => Effect.Effect<readonly string[], SqlError.SqlError>;
}

const upsert =
  (sql: SqlClient.SqlClient) =>
  (externalUserId: string, profile: ContactProfile) =>
    sql`
      INSERT INTO contacts ("externalUserId", name, username, email, phone, "updatedAt")
      VALUES (${externalUserId}, ${profile.name}, ${profile.username},
              ${profile.email}, ${profile.phone}, now())
      ON CONFLICT ("externalUserId") DO UPDATE
        SET name = EXCLUDED.name, username = EXCLUDED.username,
            email = EXCLUDED.email, phone = EXCLUDED.phone, "updatedAt" = now()
    `.pipe(Effect.asVoid);

const staleContactIds =
  (sql: SqlClient.SqlClient) => (ttlSeconds: number, limit: number) =>
    sql<{ readonly externalUserId: string }>`
      SELECT DISTINCT p."externalUserId"
      FROM payments p
      LEFT JOIN contacts c ON c."externalUserId" = p."externalUserId"
      WHERE c."externalUserId" IS NULL
         OR c."updatedAt" < now() - (${ttlSeconds} * interval '1 second')
      LIMIT ${limit}
    `.pipe(Effect.map((rows) => rows.map((r) => r.externalUserId)));

export const makeContactsRepo = (sql: SqlClient.SqlClient): ContactsRepo => ({
  upsert: upsert(sql),
  staleContactIds: staleContactIds(sql),
});
