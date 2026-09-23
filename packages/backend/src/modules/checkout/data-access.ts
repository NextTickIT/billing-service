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
  /**
   * Insert a session, keyed on `idempotencyKey` via INSERT … ON CONFLICT DO NOTHING:
   * returns true when THIS call inserted the row, false when a session for that key
   * already exists (a retry or a concurrent create that lost the race). A null key never
   * conflicts (the unique index is partial), so a key-less insert always returns true.
   */
  readonly insert: (
    input: NewCheckoutSession,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly findById: (
    id: string,
  ) => Effect.Effect<Option.Option<CheckoutSession>, SqlError.SqlError>;
  /** The session an idempotency key maps to (for replaying a deduped create). */
  readonly findByIdempotencyKey: (
    key: string,
  ) => Effect.Effect<Option.Option<CheckoutSession>, SqlError.SqlError>;
  /**
   * Atomically claim a payable session for payment: record the chosen method and move
   * it to `pending`, but ONLY from `created`. The session id is the idempotency key —
   * a second concurrent or repeat /pay (button spam, two tabs) finds the row no longer
   * `created` and loses the claim, so exactly one caller mints exactly one provider
   * order per session. Returns true iff this call won the claim.
   */
  readonly claimForPayment: (
    id: string,
    method: number,
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  /**
   * Release a claim back to `created` after the provider mint failed, so the buyer can
   * retry (or pick another method) instead of the session bricking in `pending`. Only a
   * still-`pending` row is reopened — a callback that completed the session meanwhile is
   * never reverted.
   */
  readonly releasePending: (
    id: string,
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
  // ON CONFLICT keys on the partial unique index (idempotencyKey IS NOT NULL): a repeat
  // or concurrent create with the same key hits DO NOTHING and returns no row; a null key
  // is outside the index, so it never conflicts and always inserts.
  return sql<{ readonly id: string }>`
    INSERT INTO checkout_sessions
      (id, "externalUserId", amount, currency, period, method, kind, recurring,
       "paymentId", "successUrl", "failureUrl", promo, "idempotencyKey", "expiresAt")
    VALUES
      (${input.id}, ${input.externalUserId}, ${input.amount}, ${input.currency},
       ${input.period}, ${input.method ?? null}, ${input.kind}, ${input.recurring},
       ${input.paymentId}, ${input.successUrl}, ${input.failureUrl},
       ${promo}::jsonb, ${input.idempotencyKey}, ${input.expiresAt})
    ON CONFLICT ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL DO NOTHING
    RETURNING id
  `.pipe(Effect.map((rows) => rows.length > 0));
};

const findById = (sql: SqlClient.SqlClient) => (id: string) =>
  sql<CheckoutSession>`
    SELECT ${sql.unsafe(COLUMNS)} FROM checkout_sessions WHERE id = ${id}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const findByIdempotencyKey = (sql: SqlClient.SqlClient) => (key: string) =>
  sql<CheckoutSession>`
    SELECT ${sql.unsafe(COLUMNS)} FROM checkout_sessions
    WHERE "idempotencyKey" = ${key}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

const claimForPayment =
  (sql: SqlClient.SqlClient) => (id: string, method: number) =>
    sql<{ readonly id: string }>`
      UPDATE checkout_sessions
      SET method = ${method}, status = ${CheckoutSessionStatus.Pending}
      WHERE id = ${id} AND status = ${CheckoutSessionStatus.Created}
      RETURNING id
    `.pipe(Effect.map((rows) => rows.length > 0));

const releasePending = (sql: SqlClient.SqlClient) => (id: string) =>
  sql`
    UPDATE checkout_sessions SET status = ${CheckoutSessionStatus.Created}
    WHERE id = ${id} AND status = ${CheckoutSessionStatus.Pending}
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
  findByIdempotencyKey: findByIdempotencyKey(sql),
  claimForPayment: claimForPayment(sql),
  releasePending: releasePending(sql),
  markCompleted: markCompleted(sql),
  renameOpenSessionsExternalUser: renameOpenSessionsExternalUser(sql),
});
