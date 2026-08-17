import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect } from 'effect';

import type {
  ErrorDetail,
  MessageStatus,
  Outcome,
} from '@/infra/queue/policy.js';

/**
 * Queue data-access — the SQL behind docs/09. Every mutation is a single
 * statement (its own implicit transaction) whose data-modifying CTEs keep the
 * append-only `message_status_events` log in lock-step with the `messages.status`
 * cache, so a transition can never be recorded without its status row (R6).
 *
 * Same shape as the auth repo: `(sql) => (input) => Effect`, columns double-quoted
 * camelCase, jsonb bound as `${JSON.stringify(x)}::jsonb` (no name transform).
 */

export interface EnqueueInput {
  readonly messageType: string;
  readonly idemKey: string;
  readonly payload: unknown;
}

export interface EnqueueResult {
  /** false when `(messageType, idemKey)` already existed — no new message fired. */
  readonly enqueued: boolean;
  readonly messageId: string | null;
}

export interface ClaimedMessage {
  readonly id: string;
  readonly messageType: string;
  readonly idemKey: string;
  readonly payload: unknown;
  /** Attempt number for this claim (post-increment): 1 on the first try. */
  readonly attemptCount: number;
}

export interface CompleteInput {
  readonly messageId: string;
  readonly attemptNo: number;
  readonly workerId: string;
  readonly startedAt: Date;
  readonly now: Date;
  readonly result: unknown;
  readonly error: ErrorDetail | null;
  readonly outcome: Outcome;
}

/**
 * R1 + R2 in one transaction: try to insert the message (unique on
 * `(messageType, idemKey)`); always append a `raw_events` row with its own
 * receipt time, flagged duplicate when the insert was a no-op; wake idle workers
 * only when a new message actually fired.
 */
export const enqueue =
  (sql: SqlClient.SqlClient) =>
  (input: EnqueueInput): Effect.Effect<EnqueueResult, SqlError.SqlError> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const inserted = yield* sql<{ readonly id: string }>`
          INSERT INTO messages ("messageType", "idemKey", payload)
          VALUES (${input.messageType}, ${input.idemKey}, ${JSON.stringify(input.payload)}::jsonb)
          ON CONFLICT ("messageType", "idemKey") DO NOTHING
          RETURNING id
        `;
        const enqueued = inserted.length > 0;
        yield* sql`
          INSERT INTO raw_events ("messageType", "idemKey", payload, "wasDuplicate")
          VALUES (${input.messageType}, ${input.idemKey}, ${JSON.stringify(input.payload)}::jsonb, ${!enqueued})
        `;
        if (enqueued) {
          yield* sql`SELECT pg_notify('new_message', '')`;
        }
        return { enqueued, messageId: inserted[0]?.id ?? null };
      }),
    );

/**
 * R3 — claim up to `limit` due messages of a KNOWN type, cluster-safe via
 * `FOR UPDATE SKIP LOCKED`. Filtering by the handler types the worker actually
 * has means an unhandled message is never claimed-and-lost. The claim flips the
 * rows to `in_progress`, bumps `attemptCount`, and logs the transition — all in
 * one statement. `types` empty → nothing is claimable (returns []).
 */
export const claimBatch =
  (sql: SqlClient.SqlClient) =>
  (params: {
    readonly workerId: string;
    readonly limit: number;
    readonly types: readonly string[];
  }): Effect.Effect<readonly ClaimedMessage[], SqlError.SqlError> => {
    if (params.types.length === 0) {
      return Effect.succeed([]);
    }
    return sql<ClaimedMessage>`
      WITH claimed AS (
        SELECT id FROM messages
        WHERE status IN ('pending', 'retry')
          AND ("retryAt" IS NULL OR "retryAt" <= now())
          AND "messageType" IN ${sql.in(params.types)}
        ORDER BY id
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      ),
      upd AS (
        UPDATE messages m
        SET status = 'in_progress',
            "lockedBy" = ${params.workerId},
            "lockedAt" = now(),
            "attemptCount" = m."attemptCount" + 1
        FROM claimed
        WHERE m.id = claimed.id
        RETURNING m.id, m."messageType", m."idemKey", m.payload, m."attemptCount"
      ),
      logged AS (
        INSERT INTO message_status_events ("messageId", status)
        SELECT id, 'in_progress' FROM upd
      )
      SELECT id, "messageType", "idemKey", payload, "attemptCount"
      FROM upd
      ORDER BY id
    `;
  };

/**
 * R4 + R5 + R6 in one statement: append the attempt row (with result or full
 * error), append the status transition, and advance the `messages` cache to the
 * decided `outcome` (terminal → `finishedAt` set; retry → `retryAt` set, lock
 * cleared).
 */
export const complete =
  (sql: SqlClient.SqlClient) =>
  (input: CompleteInput): Effect.Effect<void, SqlError.SqlError> => {
    const attemptStatus: Extract<MessageStatus, 'success' | 'fail'> =
      input.outcome.status === 'success' ? 'success' : 'fail';
    const result = input.result === null ? null : JSON.stringify(input.result);
    const error = input.error === null ? null : JSON.stringify(input.error);
    const finishedAt = input.outcome.finished ? input.now : null;
    return sql`
      WITH att AS (
        INSERT INTO attempts
          ("messageId", "attemptNo", "workerId", "startedAt", status, result, error)
        VALUES
          (${input.messageId}, ${input.attemptNo}, ${input.workerId}, ${input.startedAt},
           ${attemptStatus}, ${result}::jsonb, ${error}::jsonb)
      ),
      logged AS (
        INSERT INTO message_status_events ("messageId", status)
        VALUES (${input.messageId}, ${input.outcome.status})
      )
      UPDATE messages
      SET status = ${input.outcome.status},
          "retryAt" = ${input.outcome.retryAt},
          "lockedBy" = NULL,
          "lockedAt" = NULL,
          "finishedAt" = ${finishedAt}
      WHERE id = ${input.messageId}
    `.pipe(Effect.asVoid);
  };

/**
 * Requeue messages whose worker died mid-flight: `in_progress` past the
 * visibility timeout go back to `retry` (lock cleared, eligible now), logged.
 * Handlers must be idempotent, since a reaped message will run again.
 */
export const reapStale =
  (sql: SqlClient.SqlClient) =>
  (timeoutSeconds: number): Effect.Effect<number, SqlError.SqlError> =>
    sql<{ readonly id: string }>`
      WITH stale AS (
        SELECT id FROM messages
        WHERE status = 'in_progress'
          AND "lockedAt" < now() - make_interval(secs => ${timeoutSeconds})
        FOR UPDATE SKIP LOCKED
      ),
      upd AS (
        UPDATE messages m
        SET status = 'retry', "retryAt" = now(), "lockedBy" = NULL, "lockedAt" = NULL
        FROM stale
        WHERE m.id = stale.id
        RETURNING m.id
      ),
      logged AS (
        INSERT INTO message_status_events ("messageId", status)
        SELECT id, 'retry' FROM upd
      )
      SELECT id FROM upd
    `.pipe(Effect.map((rows) => rows.length));
