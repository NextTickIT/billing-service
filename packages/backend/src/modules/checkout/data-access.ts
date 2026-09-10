import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  CheckoutSession,
  CheckoutSessionStatus,
  type NewCheckoutSession,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import { columnList } from '@/infra/db/columns.js';

export interface CheckoutRepo {
  readonly insert: (
    input: NewCheckoutSession,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly findById: (
    id: string,
  ) => Effect.Effect<Option.Option<CheckoutSession>, SqlError.SqlError>;
  /** Record the chosen method and move the session to `pending`. */
  readonly setPending: (
    id: string,
    method: number,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly markCompleted: (
    id: string,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /**
   * Remap OPEN (created/pending) sessions of one external user to another (docs/31),
   * returning how many moved. Only in-flight sessions move so a pending payment
   * completes under the new id; completed/expired sessions are historical facts and
   * keep their original id. `externalUserId` is carried verbatim (AC9).
   */
  readonly renameOpenSessionsExternalUser: (
    from: string,
    to: string,
  ) => Effect.Effect<number, SqlError.SqlError>;
}

const COLUMNS = columnList(CheckoutSession.fields);

const insert = (sql: SqlClient.SqlClient) => (input: NewCheckoutSession) => {
  // jsonb bound as `${JSON.stringify(x)}::jsonb`; a bare null stays SQL NULL (no promo),
  // never the jsonb `'null'` literal — mirrors the queue/outbox jsonb convention.
  const promo = input.promo === null ? null : JSON.stringify(input.promo);
  return sql`
    INSERT INTO checkout_sessions
      (id, "externalUserId", amount, currency, period, method, kind, recurring,
       "paymentId", "successUrl", "failureUrl", promo, "expiresAt")
    VALUES
      (${input.id}, ${input.externalUserId}, ${input.amount}, ${input.currency},
       ${input.period}, ${input.method ?? null}, ${input.kind}, ${input.recurring},
       ${input.paymentId}, ${input.successUrl}, ${input.failureUrl},
       ${promo}::jsonb, ${input.expiresAt})
  `.pipe(Effect.asVoid);
};

const findById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<CheckoutSession>`
    SELECT ${sql.unsafe(COLUMNS)} FROM checkout_sessions WHERE id = ${id}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const setPending = (sql: SqlClient.SqlClient) => (id: string, method: number) =>
  sql`
    UPDATE checkout_sessions
    SET method = ${method}, status = ${CheckoutSessionStatus.Pending}
    WHERE id = ${id}
  `.pipe(Effect.asVoid);

const markCompleted = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE checkout_sessions SET status = ${CheckoutSessionStatus.Completed}
    WHERE id = ${id}
  `.pipe(Effect.asVoid);

const renameOpenSessionsExternalUser =
  (sql: SqlClient.SqlClient) => (from: string, to: string) =>
    sql<{ readonly id: string }>`
      UPDATE checkout_sessions SET "externalUserId" = ${to}
      WHERE "externalUserId" = ${from}
        AND status IN (${CheckoutSessionStatus.Created}, ${CheckoutSessionStatus.Pending})
      RETURNING id
    `.pipe(Effect.map((rows) => rows.length));

export const makeCheckoutRepo = (sql: SqlClient.SqlClient): CheckoutRepo => ({
  insert: insert(sql),
  findById: findById(sql),
  setPending: setPending(sql),
  markCompleted: markCompleted(sql),
  renameOpenSessionsExternalUser: renameOpenSessionsExternalUser(sql),
});
