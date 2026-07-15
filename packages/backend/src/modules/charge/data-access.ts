import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect, Option } from 'effect';

import { requireRow } from '@/infra/db/rows.js';
import type { Charge, ChargeStatus } from '@/modules/charge/contracts.js';

/** How an incoming charge resolved, cached on the row for the operator/audit. */
export type MatchOutcome = 'unmatched' | 'matched' | 'quarantined';

export interface NewPayment {
  readonly incomingEventId: string;
  /** null when bound by an operator without a gateway subscription (yet). */
  readonly subscriptionId: string | null;
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: number;
  readonly source: string;
  readonly occurredAt: Date;
}

/** An open quarantine row joined with its incoming charge (operator queue view). */
export interface QuarantineListRow {
  readonly quarantineId: string;
  readonly incomingEventId: string;
  readonly source: string;
  readonly externalRef: string;
  readonly amount: number;
  readonly currency: number;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly detail: unknown;
}

/**
 * Charge-pipeline persistence. `upsertIncomingCharge` is idempotent on the source
 * key and always returns the row id (so a retry after partial processing can still
 * finish); `insertPayment`/`upsertQuarantine` are idempotent too, so the whole
 * handler is safe to replay. Same `(sql) => (input)` shape as the other repos.
 */
export interface ChargeRepo {
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  readonly upsertIncomingCharge: (
    event: Charge,
  ) => Effect.Effect<string, SqlError.SqlError>;
  readonly setMatchResult: (
    id: string,
    outcome: MatchOutcome,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insertPayment: (
    input: NewPayment,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertQuarantine: (
    incomingEventId: string,
  ) => Effect.Effect<string, SqlError.SqlError>;
  readonly getIncomingChargeById: (
    id: string,
  ) => Effect.Effect<Option.Option<Charge>, SqlError.SqlError>;
  readonly listOpenQuarantine: () => Effect.Effect<
    readonly QuarantineListRow[],
    SqlError.SqlError
  >;
  readonly getQuarantine: (id: string) => Effect.Effect<
    Option.Option<{
      readonly incomingEventId: string;
      readonly status: string;
    }>,
    SqlError.SqlError
  >;
  readonly resolveQuarantine: (
    incomingEventId: string,
    boundSubscriptionId: string | null,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly insertAudit: (
    entry: AuditEntry,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const upsertIncomingCharge =
  (sql: SqlClient.SqlClient) => (event: Charge) =>
    sql<{ readonly id: string }>`
      INSERT INTO charges
        (source, "idemKey", "externalRef", "externalUserId", amount, currency, status, "occurredAt", payload)
      VALUES
        (${event.source}, ${event.idemKey}, ${event.externalRef}, ${event.externalUserId},
         ${event.amount}, ${event.currency}, ${event.status}, ${event.occurredAt},
         ${JSON.stringify(event.payload)}::jsonb)
      ON CONFLICT ("idemKey") DO UPDATE SET "idemKey" = EXCLUDED."idemKey"
      RETURNING id
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.map((row) => row.id),
    );

const setMatchResult =
  (sql: SqlClient.SqlClient) => (id: string, outcome: MatchOutcome) =>
    sql`
      UPDATE charges SET "matchResult" = ${outcome} WHERE id = ${id}
    `.pipe(Effect.asVoid);

const insertPayment = (sql: SqlClient.SqlClient) => (input: NewPayment) =>
  sql`
    INSERT INTO charge_fixations
      ("incomingEventId", "subscriptionId", "externalUserId", amount, currency, source, "occurredAt")
    VALUES
      (${input.incomingEventId}, ${input.subscriptionId}, ${input.externalUserId},
       ${input.amount}, ${input.currency}, ${input.source}, ${input.occurredAt})
    ON CONFLICT ("incomingEventId") DO NOTHING
  `.pipe(Effect.asVoid);

const upsertQuarantine =
  (sql: SqlClient.SqlClient) => (incomingEventId: string) =>
    sql<{ readonly id: string }>`
      INSERT INTO quarantine_records ("incomingEventId")
      VALUES (${incomingEventId})
      ON CONFLICT ("incomingEventId") DO UPDATE SET status = quarantine_records.status
      RETURNING id
    `.pipe(
      Effect.flatMap(requireRow),
      Effect.map((row) => row.id),
    );

interface ChargeRow {
  readonly source: string;
  readonly idemKey: string;
  readonly externalRef: string;
  readonly externalUserId: string | null;
  readonly amount: number;
  readonly currency: number;
  readonly status: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

const getIncomingChargeById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<ChargeRow>`
    SELECT source, "idemKey", "externalRef", "externalUserId", amount, currency,
           status, "occurredAt", payload
    FROM charges WHERE id = ${id}
  `.pipe(
    Effect.map((rows) => Option.fromNullable(rows[0])),
    Effect.map(
      Option.map((r): Charge => ({
        ...r,
        status: r.status as ChargeStatus,
      })),
    ),
  );

const listOpenQuarantine = (sql: SqlClient.SqlClient) => () =>
  sql<QuarantineListRow>`
    SELECT q.id AS "quarantineId", e.id AS "incomingEventId", e.source,
           e."externalRef", e.amount, e.currency, e."occurredAt", q."createdAt"
    FROM quarantine_records q
    JOIN charges e ON e.id = q."incomingEventId"
    WHERE q.status = 'open'
    ORDER BY q."createdAt" DESC
    LIMIT 200
  `;

const getQuarantine = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly incomingEventId: string; readonly status: string }>`
    SELECT "incomingEventId", status FROM quarantine_records WHERE id = ${id}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const resolveQuarantine =
  (sql: SqlClient.SqlClient) =>
  (incomingEventId: string, boundSubscriptionId: string | null) =>
    sql`
      UPDATE quarantine_records
      SET status = 'resolved',
          "boundSubscriptionId" = ${boundSubscriptionId},
          "resolvedAt" = now()
      WHERE "incomingEventId" = ${incomingEventId}
    `.pipe(Effect.asVoid);

const insertAudit = (sql: SqlClient.SqlClient) => (entry: AuditEntry) =>
  sql`
    INSERT INTO audit_log (actor, action, "targetType", "targetId", detail)
    VALUES (${entry.actor}, ${entry.action}, ${entry.targetType}, ${entry.targetId},
            ${JSON.stringify(entry.detail)}::jsonb)
  `.pipe(Effect.asVoid);

export const makeChargeRepo = (sql: SqlClient.SqlClient): ChargeRepo => ({
  transaction: (effect) => sql.withTransaction(effect),
  upsertIncomingCharge: upsertIncomingCharge(sql),
  setMatchResult: setMatchResult(sql),
  insertPayment: insertPayment(sql),
  upsertQuarantine: upsertQuarantine(sql),
  getIncomingChargeById: getIncomingChargeById(sql),
  listOpenQuarantine: listOpenQuarantine(sql),
  getQuarantine: getQuarantine(sql),
  resolveQuarantine: resolveQuarantine(sql),
  insertAudit: insertAudit(sql),
});
