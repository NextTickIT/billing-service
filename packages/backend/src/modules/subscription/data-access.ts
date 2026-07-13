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

/** Retry state after a failed recurring charge (FR-005). */
export interface RetryState {
  readonly firstFailureAt: Date;
  readonly retryAttempt: number;
  readonly nextChargeDate: Date;
}

/**
 * Subscription persistence (FR-003/004/005). Same `(sql) => (input)` shape as the
 * other repos; columns are the shared field names verbatim. `extend`/`advanceAfter
 * Success` reset the retry state (a good payment restores standing).
 */
export interface SubscriptionRepo {
  readonly findActiveByExternalUser: (
    externalUserId: string,
  ) => Effect.Effect<Option.Option<Subscription>, SqlError.SqlError>;
  readonly findById: (
    id: string,
  ) => Effect.Effect<Option.Option<Subscription>, SqlError.SqlError>;
  /** Subscriptions due to be charged now (active or in the retry window). */
  readonly findDue: (
    now: Date,
    limit: number,
  ) => Effect.Effect<readonly Subscription[], SqlError.SqlError>;
  readonly insert: (
    input: CreateSubscription,
  ) => Effect.Effect<Subscription, SqlError.SqlError>;
  readonly extend: (
    id: string,
    input: ExtendSubscription,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly advanceAfterSuccess: (
    id: string,
    nextChargeDate: Date,
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
  ) => Effect.Effect<readonly Subscription[], SqlError.SqlError>;
  /** Cancel unless already ended; returns false if it was already cancelled. */
  readonly cancel: (id: string) => Effect.Effect<boolean, SqlError.SqlError>;
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

const findById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<Subscription>`
    SELECT ${sql.unsafe(COLUMNS)} FROM subscriptions WHERE id = ${id}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const findDue = (sql: SqlClient.SqlClient) => (now: Date, limit: number) =>
  sql<Subscription>`
    SELECT ${sql.unsafe(COLUMNS)} FROM subscriptions
    WHERE status IN (${SubscriptionStatus.Active}, ${SubscriptionStatus.PastDue})
      AND "nextChargeDate" <= ${now}
      AND "recurringTokenRef" IS NOT NULL
    ORDER BY "nextChargeDate"
    LIMIT ${limit}
  `;

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

const advanceAfterSuccess =
  (sql: SqlClient.SqlClient) => (id: string, nextChargeDate: Date) =>
    sql`
      UPDATE subscriptions
      SET status = ${SubscriptionStatus.Active}, "nextChargeDate" = ${nextChargeDate},
          "firstFailureAt" = NULL, "retryAttempt" = 0, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

const recordRetry =
  (sql: SqlClient.SqlClient) => (id: string, state: RetryState) =>
    sql`
      UPDATE subscriptions
      SET status = ${SubscriptionStatus.PastDue},
          "firstFailureAt" = ${state.firstFailureAt},
          "retryAttempt" = ${state.retryAttempt},
          "nextChargeDate" = ${state.nextChargeDate}, "updatedAt" = now()
      WHERE id = ${id}
    `.pipe(Effect.asVoid);

const markRenewalFailed = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE subscriptions SET status = ${SubscriptionStatus.RenewalFailed},
      "updatedAt" = now() WHERE id = ${id}
  `.pipe(Effect.asVoid);

const findByExternalUser =
  (sql: SqlClient.SqlClient) => (externalUserId: string) =>
    sql<Subscription>`
      SELECT ${sql.unsafe(COLUMNS)} FROM subscriptions
      WHERE "externalUserId" = ${externalUserId}
      ORDER BY "createdAt" DESC
    `;

const cancel = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<{ readonly id: string }>`
    UPDATE subscriptions SET status = ${SubscriptionStatus.Cancelled}, "updatedAt" = now()
    WHERE id = ${id} AND status <> ${SubscriptionStatus.Cancelled}
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));

export const makeSubscriptionRepo = (
  sql: SqlClient.SqlClient,
): SubscriptionRepo => ({
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
