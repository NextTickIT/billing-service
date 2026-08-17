import { SqlClient } from '@effect/sql';
import type { SqlError, Statement } from '@effect/sql';
import {
  type CreatePayment,
  Payment,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import { columnList } from '@/infra/db/columns.js';
import { requireRow } from '@/infra/db/rows.js';

/** New billing terms applied when a checkout extends an existing payment. */
export interface ExtendPayment {
  readonly amount: number;
  readonly currency: number;
  readonly method: number;
  readonly period: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly nextPaymentDate: Date;
  readonly recurringTokenRef: string | null;
}

/** Retry state after a failed recurring charge (FR-005). */
export interface RetryState {
  readonly firstFailureAt: Date;
  readonly retryAttempt: number;
  readonly nextPaymentDate: Date;
}

/** Anchor pair written on a successful charge advance. */
export interface AdvanceAnchor {
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly nextPaymentDate: Date;
}

/**
 * Payment persistence (FR-003/004/005). Same `(sql) => (input)` shape as the
 * other repos; columns are the shared field names verbatim. `extend`/`advanceAfter
 * Success` reset the retry state (a good payment restores standing).
 */
export interface PaymentRepo {
  readonly findActiveByExternalUser: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<Payment>, SqlError.SqlError>;
  readonly findById: (
    id: string,
  ) => Effect.Effect<Option.Option<Payment>, SqlError.SqlError>;
  /** Payments due to be charged now (active or in the retry window). */
  readonly findDue: (
    now: Date,
    limit: number,
  ) => Effect.Effect<readonly Payment[], SqlError.SqlError>;
  readonly insert: (
    input: CreatePayment,
  ) => Effect.Effect<Payment, SqlError.SqlError>;
  readonly extend: (
    id: string,
    input: ExtendPayment,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly advanceAfterSuccess: (
    id: string,
    anchor: AdvanceAnchor,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly recordRetry: (
    id: string,
    state: RetryState,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly markRenewalFailed: (
    id: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly findByExternalUser: (
    externalUserId: string,
  ) => Effect.Effect<readonly Payment[], SqlError.SqlError>;
  /**
   * All payments, newest first — the operator's default table view. An optional
   * filter narrows by status buckets and/or the derived "cancelling" state.
   */
  readonly listAll: (
    limit: number,
    filter?: PaymentListFilter,
  ) => Effect.Effect<readonly Payment[], SqlError.SqlError>;
  /**
   * Soft-cancel: flag an active payment for lapse at its due date (docs/23).
   * Keeps `status = active`; returns false if it was not active or already
   * flagged, so the route can reject with a 422.
   */
  readonly requestCancel: (
    id: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** Reverse a pending cancel within the grace window; false if none pending. */
  readonly clearCancelRequest: (
    id: string,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /** At the due date, flip a cancel-pending payment to `cancelled` (idempotent). */
  readonly markCancelledLapsed: (
    id: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /**
   * Supersede a payment unconditionally (→ `cancelled`): used when a legacy
   * `external` payment is replaced by a new managed one at checkout (docs/25 §4.4),
   * freeing the one-active-per-user slot for the takeover.
   */
  readonly supersede: (id: string) => Effect.Effect<void, SqlError.SqlError>;
  /** Deferral: push the anchor + re-derived next date on an active payment. */
  readonly defer: (
    id: string,
    newPeriodEnd: Date,
    newNextPaymentDate: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Rewrite only the stored token — a card change must not shift any date. */
  readonly updateToken: (
    id: string,
    recToken: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

/**
 * The operator list filter (docs/23): a set of status buckets OR'd together,
 * with `cancelling` as a derived bucket (`active AND cancelRequestedAt NOT NULL`)
 * — modelled as a boolean, not a `PaymentStatus`, since it is not an enum value.
 */
export interface PaymentListFilter {
  readonly statuses?: readonly PaymentStatus[];
  readonly cancelling?: boolean;
}

const COLUMNS = columnList(Payment.fields);

const findActiveByExternalUser =
  (sql: SqlClient.SqlClient) => (externalUserId: string) =>
    sql<Payment>`
      SELECT ${sql.unsafe(COLUMNS)} FROM payments
      WHERE "externalUserId" = ${externalUserId} AND status = ${PaymentStatus.Active}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const findById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<Payment>`
    SELECT ${sql.unsafe(COLUMNS)} FROM payments WHERE id = ${id}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const findDue = (sql: SqlClient.SqlClient) => (now: Date, limit: number) =>
  sql<Payment>`
    SELECT ${sql.unsafe(COLUMNS)} FROM payments
    WHERE status IN (${PaymentStatus.Active}, ${PaymentStatus.PastDue})
      AND "nextPaymentDate" <= ${now}
      AND "recurringTokenRef" IS NOT NULL
    ORDER BY "nextPaymentDate"
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;

const insert = (sql: SqlClient.SqlClient) => (input: CreatePayment) =>
  sql<Payment>`
    INSERT INTO payments
      ("externalUserId", amount, currency, method, period, status,
       "currentPeriodStart", "currentPeriodEnd", "nextPaymentDate",
       "recurringTokenRef", "firstFailureAt", "retryAttempt")
    VALUES
      (${input.externalUserId}, ${input.amount}, ${input.currency}, ${input.method},
       ${input.period}, ${input.status}, ${input.currentPeriodStart},
       ${input.currentPeriodEnd}, ${input.nextPaymentDate},
       ${input.recurringTokenRef}, ${input.firstFailureAt}, ${input.retryAttempt})
    RETURNING ${sql.unsafe(COLUMNS)}
  `.pipe(Effect.flatMap(requireRow));

const extend =
  (sql: SqlClient.SqlClient) => (id: string, input: ExtendPayment) =>
    sql`
      UPDATE payments
      SET amount = ${input.amount}, currency = ${input.currency}, method = ${input.method},
          period = ${input.period}, status = ${PaymentStatus.Active},
          "currentPeriodStart" = ${input.currentPeriodStart},
          "currentPeriodEnd" = ${input.currentPeriodEnd},
          "nextPaymentDate" = ${input.nextPaymentDate},
          "recurringTokenRef" = ${input.recurringTokenRef},
          "firstFailureAt" = NULL, "retryAttempt" = 0, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

const advanceAfterSuccess =
  (sql: SqlClient.SqlClient) => (id: string, anchor: AdvanceAnchor) =>
    sql`
      UPDATE payments
      SET status = ${PaymentStatus.Active},
          "currentPeriodStart" = ${anchor.currentPeriodStart},
          "currentPeriodEnd" = ${anchor.currentPeriodEnd},
          "nextPaymentDate" = ${anchor.nextPaymentDate},
          "firstFailureAt" = NULL, "retryAttempt" = 0, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

const recordRetry =
  (sql: SqlClient.SqlClient) => (id: string, state: RetryState) =>
    sql`
      UPDATE payments
      SET status = ${PaymentStatus.PastDue},
          "firstFailureAt" = ${state.firstFailureAt},
          "retryAttempt" = ${state.retryAttempt},
          "nextPaymentDate" = ${state.nextPaymentDate}, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

const markRenewalFailed = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE payments SET status = ${PaymentStatus.RenewalFailed},
      "updatedAt" = now() WHERE id = ${id}
  `.pipe(Effect.asVoid);

const findByExternalUser =
  (sql: SqlClient.SqlClient) => (externalUserId: string) =>
    sql<Payment>`
      SELECT ${sql.unsafe(COLUMNS)} FROM payments
      WHERE "externalUserId" = ${externalUserId}
      ORDER BY "createdAt" DESC
    `;

/**
 * Turn the filter into disjoint status buckets OR'd together. `active` excludes
 * cancel-pending rows (they render as "cancelling"); `cancelling` is that derived
 * bucket. `sql.or` of equality fragments — not `sql.in`, whose pg quirk drops the
 * `IN` keyword (CLAUDE.md §5).
 */
const listFilterConditions = (
  sql: SqlClient.SqlClient,
  filter: PaymentListFilter,
): readonly Statement.Fragment[] => {
  const conditions: Statement.Fragment[] = [];
  for (const status of filter.statuses ?? []) {
    conditions.push(
      status === PaymentStatus.Active
        ? sql`(status = ${PaymentStatus.Active} AND "cancelRequestedAt" IS NULL)`
        : sql`status = ${status}`,
    );
  }
  if (filter.cancelling === true) {
    conditions.push(
      sql`(status = ${PaymentStatus.Active} AND "cancelRequestedAt" IS NOT NULL)`,
    );
  }
  return conditions;
};

const listAll =
  (sql: SqlClient.SqlClient) => (limit: number, filter?: PaymentListFilter) => {
    const conditions =
      filter === undefined ? [] : listFilterConditions(sql, filter);
    const where =
      conditions.length === 0 ? sql`` : sql`WHERE ${sql.or(conditions)}`;
    return sql<Payment>`
      SELECT ${sql.unsafe(COLUMNS)} FROM payments
      ${where}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
  };

const requestCancel = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly id: string }>`
    UPDATE payments SET "cancelRequestedAt" = now(), "updatedAt" = now()
    WHERE id = ${id} AND status = ${PaymentStatus.Active}
      AND "cancelRequestedAt" IS NULL
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));

const clearCancelRequest = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly id: string }>`
    UPDATE payments SET "cancelRequestedAt" = NULL, "updatedAt" = now()
    WHERE id = ${id} AND status = ${PaymentStatus.Active}
      AND "cancelRequestedAt" IS NOT NULL
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));

const markCancelledLapsed = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE payments SET status = ${PaymentStatus.Cancelled}, "updatedAt" = now()
    WHERE id = ${id} AND "cancelRequestedAt" IS NOT NULL
  `.pipe(Effect.asVoid);

const supersede = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE payments SET status = ${PaymentStatus.Cancelled}, "updatedAt" = now()
    WHERE id = ${id}
  `.pipe(Effect.asVoid);

const defer =
  (sql: SqlClient.SqlClient) =>
  (id: string, newPeriodEnd: Date, newNextPaymentDate: Date) =>
    sql`
      UPDATE payments
      SET "currentPeriodEnd" = ${newPeriodEnd},
          "nextPaymentDate" = ${newNextPaymentDate}, "updatedAt" = now()
      WHERE id = ${id} AND status = ${PaymentStatus.Active}
    `.pipe(Effect.asVoid);

const updateToken =
  (sql: SqlClient.SqlClient) => (id: string, recToken: string) =>
    sql`
      UPDATE payments
      SET "recurringTokenRef" = ${recToken}, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

export const makePaymentRepo = (sql: SqlClient.SqlClient): PaymentRepo => ({
  findActiveByExternalUser: findActiveByExternalUser(sql),
  findById: findById(sql),
  findDue: findDue(sql),
  insert: insert(sql),
  extend: extend(sql),
  advanceAfterSuccess: advanceAfterSuccess(sql),
  recordRetry: recordRetry(sql),
  markRenewalFailed: markRenewalFailed(sql),
  findByExternalUser: findByExternalUser(sql),
  listAll: listAll(sql),
  requestCancel: requestCancel(sql),
  clearCancelRequest: clearCancelRequest(sql),
  markCancelledLapsed: markCancelledLapsed(sql),
  supersede: supersede(sql),
  defer: defer(sql),
  updateToken: updateToken(sql),
});
