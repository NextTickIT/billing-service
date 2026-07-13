import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  type CreateSubscription,
  type Subscription,
  SubscriptionStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

/** New billing terms applied when a checkout extends an existing subscription. */
export interface ExtendSubscription {
  readonly amount: number;
  readonly currency: number;
  readonly method: number;
  readonly period: string;
  readonly nextChargeDate: Date;
  readonly recurringTokenRef: string | null;
}

/**
 * Subscription persistence (FR-003/004). Same `(sql) => (input)` shape as the
 * other repos; columns are the shared field names verbatim. `extend` resets the
 * retry state (a fresh checkout payment restores good standing) — see FR-005.
 */
export interface SubscriptionRepo {
  readonly findActiveByExternalUser: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<Subscription>, SqlError.SqlError>;
  readonly insert: (
    input: CreateSubscription,
  ) => Effect.Effect<Subscription, SqlError.SqlError>;
  readonly extend: (
    id: string,
    input: ExtendSubscription,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

const COLUMNS = `id, "externalUserId", amount, currency, method, period, status,
  "nextChargeDate", "recurringTokenRef", "firstFailureAt", "retryAttempt",
  "createdAt", "updatedAt"`;

const requireRow = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;
  return row === undefined
    ? Effect.dieMessage('expected a RETURNING row')
    : Effect.succeed(row);
};

const findActiveByExternalUser =
  (sql: SqlClient.SqlClient) => (externalUserId: string) =>
    sql<Subscription>`
      SELECT ${sql.unsafe(COLUMNS)} FROM subscriptions
      WHERE "externalUserId" = ${externalUserId} AND status = ${SubscriptionStatus.Active}
    `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const insert = (sql: SqlClient.SqlClient) => (input: CreateSubscription) =>
  sql<Subscription>`
    INSERT INTO subscriptions
      ("externalUserId", amount, currency, method, period, status,
       "nextChargeDate", "recurringTokenRef", "firstFailureAt", "retryAttempt")
    VALUES
      (${input.externalUserId}, ${input.amount}, ${input.currency}, ${input.method},
       ${input.period}, ${input.status}, ${input.nextChargeDate},
       ${input.recurringTokenRef}, ${input.firstFailureAt}, ${input.retryAttempt})
    RETURNING ${sql.unsafe(COLUMNS)}
  `.pipe(Effect.flatMap(requireRow));

const extend =
  (sql: SqlClient.SqlClient) => (id: string, input: ExtendSubscription) =>
    sql`
      UPDATE subscriptions
      SET amount = ${input.amount}, currency = ${input.currency}, method = ${input.method},
          period = ${input.period}, status = ${SubscriptionStatus.Active},
          "nextChargeDate" = ${input.nextChargeDate},
          "recurringTokenRef" = ${input.recurringTokenRef},
          "firstFailureAt" = NULL, "retryAttempt" = 0, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

export const makeSubscriptionRepo = (
  sql: SqlClient.SqlClient,
): SubscriptionRepo => ({
  findActiveByExternalUser: findActiveByExternalUser(sql),
  insert: insert(sql),
  extend: extend(sql),
});
