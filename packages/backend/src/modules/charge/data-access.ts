import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect, Option } from 'effect';

import { requireRow } from '@/infra/db/rows.js';
import type { Charge, ChargeStatus } from '@/modules/charge/contracts.js';

/** How an incoming charge resolved, cached on the row for the operator/audit. */
export type MatchOutcome = 'unmatched' | 'matched' | 'quarantined';

export interface NewPayment {
  readonly incomingEventId: string;
  /** null when bound by an operator without a gateway payment (yet). */
  readonly paymentId: string | null;
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

export interface ChargeFixation {
  readonly id: string;
  readonly incomingEventId: string;
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: number;
  readonly source: string;
  readonly occurredAt: Date;
}

/**
 * The success a refund reverses: the settled charge of the order and the fixation that
 * recorded it. `idemKey` is the success charge's key, from which its event id derives.
 */
export interface SettledOriginal {
  readonly idemKey: string;
  readonly externalUserId: string;
  /** null when an operator bound the success without a gateway payment. */
  readonly paymentId: string | null;
}

/** A refund charge still in quarantine, as the refund backfill selects it. */
export interface QuarantinedRefund {
  readonly id: string;
  readonly charge: Charge;
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
  /**
   * The charge's current match outcome, read under a row lock held to the end of the
   * surrounding transaction: the first statement of settlement. A concurrent attempt on
   * the same charge (a reaper requeue of a slow first attempt) waits for that lock —
   * already at its own `upsertIncomingCharge`, whose ON CONFLICT update needs the same
   * row — until the first commits, then reads `'matched'` here and does nothing.
   * Meaningless outside a transaction. A missing row is a defect: it was upserted just
   * before.
   */
  readonly lockMatchResult: (
    id: string,
  ) => Effect.Effect<MatchOutcome, SqlError.SqlError>;
  /**
   * Lock the order `externalRef` names until the surrounding transaction ends, then say
   * whether a DIFFERENT charge row for it has already settled. One provider order can
   * reach the pipeline more than once under different keys — the scheduler's own copy
   * (`w4p:…|CHARGE|…`) and the WayForPay callback (`w4pcb:…`) — and each copy is its own
   * `charges` row. A concurrent copy waits on the lock, then sees the first one's commit.
   */
  readonly orderSettledByAnotherCopy: (
    externalRef: string,
    id: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /**
   * Under the same per-order lock as `orderSettledByAnotherCopy`, the order's settled
   * success that carries a fixation. A duplicate success copy is marked matched with no
   * fixation, so the join is what picks the charge that was actually recorded. Should an
   * order ever carry two fixations, one fixed to a payment wins over one bound without,
   * then the earliest.
   */
  readonly findSettledOriginal: (
    externalRef: string,
  ) => Effect.Effect<Option.Option<SettledOriginal>, SqlError.SqlError>;
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
    boundPaymentId: string | null,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /**
   * Close a refund charge's quarantine row, if it has one, because the refund was
   * attributed to its original. No payment is bound: that is `resolveQuarantine`.
   */
  readonly resolveQuarantineByRefund: (
    incomingEventId: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Whether the outbox holds an event with this id (read inside a settlement). */
  readonly eventStored: (
    id: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** Every refund charge still quarantined, oldest first (the refund backfill). */
  readonly listQuarantinedRefunds: () => Effect.Effect<
    readonly QuarantinedRefund[],
    SqlError.SqlError
  >;
  readonly insertAudit: (
    entry: AuditEntry,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly findChargesByPayment: (
    paymentId: string,
  ) => Effect.Effect<readonly ChargeFixation[], SqlError.SqlError>;
}

const upsertIncomingCharge = (sql: SqlClient.SqlClient) => (event: Charge) =>
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

const lockMatchResult = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly matchResult: MatchOutcome }>`
    SELECT "matchResult" FROM charges WHERE id = ${id} FOR UPDATE
  `.pipe(
    Effect.flatMap(requireRow),
    Effect.map((row) => row.matchResult),
  );

const orderSettledByAnotherCopy =
  (sql: SqlClient.SqlClient) => (externalRef: string, id: string) =>
    orderLock(sql, externalRef).pipe(
      Effect.andThen(
        sql<{ readonly settled: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM charges
            WHERE "externalRef" = ${externalRef} AND id <> ${id}
              AND status = 'succeeded' AND "matchResult" = 'matched'
          ) AS settled
        `,
      ),
      Effect.map((rows) => rows[0]?.settled === true),
    );

const orderLock = (sql: SqlClient.SqlClient, externalRef: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${`charge-order:${externalRef}`}))`;

const findSettledOriginal =
  (sql: SqlClient.SqlClient) => (externalRef: string) =>
    orderLock(sql, externalRef).pipe(
      Effect.andThen(
        sql<SettledOriginal>`
          SELECT c."idemKey", f."externalUserId", f."paymentId"
          FROM charges c
          JOIN charge_fixations f ON f."incomingEventId" = c.id
          WHERE c."externalRef" = ${externalRef}
            AND c.status = 'succeeded' AND c."matchResult" = 'matched'
          ORDER BY (f."paymentId" IS NULL), f."occurredAt", f.id
          LIMIT 1
        `,
      ),
      Effect.map((rows) => Option.fromNullable(rows[0])),
    );

const insertPayment = (sql: SqlClient.SqlClient) => (input: NewPayment) =>
  sql`
    INSERT INTO charge_fixations
      ("incomingEventId", "paymentId", "externalUserId", amount, currency, source, "occurredAt")
    VALUES
      (${input.incomingEventId}, ${input.paymentId}, ${input.externalUserId},
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

const chargeOf = (row: ChargeRow): Charge => ({
  ...row,
  status: row.status as ChargeStatus,
});

const getIncomingChargeById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<ChargeRow>`
    SELECT source, "idemKey", "externalRef", "externalUserId", amount, currency,
           status, "occurredAt", payload
    FROM charges WHERE id = ${id}
  `.pipe(
    Effect.map((rows) => Option.fromNullable(rows[0])),
    Effect.map(Option.map(chargeOf)),
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
  (incomingEventId: string, boundPaymentId: string | null) =>
    sql`
      UPDATE quarantine_records
      SET status = 'resolved',
          "boundPaymentId" = ${boundPaymentId},
          "resolvedAt" = now()
      WHERE "incomingEventId" = ${incomingEventId}
    `.pipe(Effect.asVoid);

const resolveQuarantineByRefund =
  (sql: SqlClient.SqlClient) => (incomingEventId: string) =>
    sql`
      UPDATE quarantine_records
      SET status = 'resolved', "resolvedAt" = now()
      WHERE "incomingEventId" = ${incomingEventId} AND status = 'open'
    `.pipe(Effect.asVoid);

const eventStored = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly found: boolean }>`
    SELECT EXISTS (SELECT 1 FROM domain_events WHERE id = ${id}) AS found
  `.pipe(Effect.map((rows) => rows[0]?.found === true));

const listQuarantinedRefunds = (sql: SqlClient.SqlClient) => () =>
  sql<ChargeRow & { readonly id: string }>`
    SELECT id, source, "idemKey", "externalRef", "externalUserId", amount, currency,
           status, "occurredAt", payload
    FROM charges
    WHERE status = 'refunded' AND "matchResult" = 'quarantined'
    ORDER BY "occurredAt", id
  `.pipe(
    Effect.map((rows) =>
      rows.map(({ id, ...row }) => ({ id, charge: chargeOf(row) })),
    ),
  );

const insertAudit = (sql: SqlClient.SqlClient) => (entry: AuditEntry) =>
  sql`
    INSERT INTO audit_log (actor, action, "targetType", "targetId", detail)
    VALUES (${entry.actor}, ${entry.action}, ${entry.targetType}, ${entry.targetId},
            ${JSON.stringify(entry.detail)}::jsonb)
  `.pipe(Effect.asVoid);

const findChargesByPayment =
  (sql: SqlClient.SqlClient) => (paymentId: string) =>
    sql<ChargeFixation>`
      SELECT id, "incomingEventId", "externalUserId", amount, currency, source, "occurredAt"
      FROM charge_fixations
      WHERE "paymentId" = ${paymentId}
      ORDER BY "occurredAt" DESC
    `;

export const makeChargeRepo = (sql: SqlClient.SqlClient): ChargeRepo => ({
  transaction: (effect) => sql.withTransaction(effect),
  upsertIncomingCharge: upsertIncomingCharge(sql),
  setMatchResult: setMatchResult(sql),
  lockMatchResult: lockMatchResult(sql),
  orderSettledByAnotherCopy: orderSettledByAnotherCopy(sql),
  findSettledOriginal: findSettledOriginal(sql),
  insertPayment: insertPayment(sql),
  upsertQuarantine: upsertQuarantine(sql),
  getIncomingChargeById: getIncomingChargeById(sql),
  listOpenQuarantine: listOpenQuarantine(sql),
  getQuarantine: getQuarantine(sql),
  resolveQuarantine: resolveQuarantine(sql),
  resolveQuarantineByRefund: resolveQuarantineByRefund(sql),
  eventStored: eventStored(sql),
  listQuarantinedRefunds: listQuarantinedRefunds(sql),
  insertAudit: insertAudit(sql),
  findChargesByPayment: findChargesByPayment(sql),
});
