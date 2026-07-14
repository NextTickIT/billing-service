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
}

const COLUMNS = columnList(CheckoutSession.fields);

const insert = (sql: SqlClient.SqlClient) => (input: NewCheckoutSession) =>
  sql`
    INSERT INTO checkout_sessions
      (id, "externalUserId", amount, currency, period, "expiresAt")
    VALUES
      (${input.id}, ${input.externalUserId}, ${input.amount}, ${input.currency},
       ${input.period}, ${input.expiresAt})
  `.pipe(Effect.asVoid);

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

export const makeCheckoutRepo = (sql: SqlClient.SqlClient): CheckoutRepo => ({
  insert: insert(sql),
  findById: findById(sql),
  setPending: setPending(sql),
  markCompleted: markCompleted(sql),
});
