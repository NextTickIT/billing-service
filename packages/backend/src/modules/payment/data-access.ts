import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
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
  /** Cancel unless already ended; returns false if it was already cancelled. */
  readonly cancel: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
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

const cancel = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly id: string }>`
    UPDATE payments SET status = ${PaymentStatus.Cancelled}, "updatedAt" = now()
    WHERE id = ${id} AND status <> ${PaymentStatus.Cancelled}
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));

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
  cancel: cancel(sql),
});
