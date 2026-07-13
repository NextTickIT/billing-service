import type { SqlClient } from '@effect/sql';
import { Cause, Clock, Duration, Effect, Exit } from 'effect';

import {
  claimBatch,
  type ClaimedMessage,
  complete,
  reapStale,
} from '@/infra/queue/store.js';
import {
  decideOutcome,
  describeError,
  type RetryConfig,
} from '@/infra/queue/policy.js';
import type { TaskHandler } from '@/infra/task-registry.js';

/**
 * The worker-side poll loop (docs/09). Each tick: reap dead-worker locks, read the
 * handler set, claim a batch of due messages of those types, run each handler, and
 * record the outcome. The loop is crash-resilient — a failed tick (SQL down, etc.)
 * is logged and the loop continues, so a transient fault never kills the worker.
 *
 * LISTEN/NOTIFY wakeup is a fast-follow (ingest already emits `pg_notify`); retries
 * fire by clock, so a poll cadence is required regardless.
 */

export interface DispatcherDeps {
  readonly sql: SqlClient.SqlClient;
  readonly handlers: () => Effect.Effect<ReadonlyMap<string, TaskHandler>>;
}

export interface DispatcherOptions {
  readonly workerId: string;
  readonly pollIntervalMillis: number;
  readonly batchSize: number;
  readonly visibilityTimeoutMillis: number;
  readonly retry: RetryConfig;
}

const processOne = (
  deps: DispatcherDeps,
  options: DispatcherOptions,
  message: ClaimedMessage,
  handler: TaskHandler,
) =>
  Effect.gen(function* () {
    const startedAt = new Date(yield* Clock.currentTimeMillis);
    // `exit`, not `either`: capture typed failures AND defects (a handler that
    // throws) so a bad handler is recorded as a failed attempt, never a crash.
    const exit = yield* Effect.exit(handler(message.payload));
    const nowMillis = yield* Clock.currentTimeMillis;
    const failed = Exit.isFailure(exit);
    const outcome = decideOutcome(
      { failed, attemptCount: message.attemptCount },
      nowMillis,
      options.retry,
    );
    yield* complete(deps.sql)({
      messageId: message.id,
      attemptNo: message.attemptCount,
      workerId: options.workerId,
      startedAt,
      now: new Date(nowMillis),
      result: null,
      error: failed ? describeError(Cause.squash(exit.cause)) : null,
      outcome,
    });
  });

const tick = (deps: DispatcherDeps, options: DispatcherOptions) =>
  Effect.gen(function* () {
    yield* reapStale(deps.sql)(options.visibilityTimeoutMillis / 1000);
    const handlers = yield* deps.handlers();
    const claimed = yield* claimBatch(deps.sql)({
      workerId: options.workerId,
      limit: options.batchSize,
      types: Array.from(handlers.keys()),
    });
    yield* Effect.forEach(
      claimed,
      (message) => {
        const handler = handlers.get(message.messageType);
        return handler === undefined
          ? Effect.void
          : processOne(deps, options, message, handler);
      },
      { discard: true },
    );
  });

export const runDispatcher = (
  deps: DispatcherDeps,
  options: DispatcherOptions,
): Effect.Effect<never> =>
  tick(deps, options).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError('queue dispatcher tick failed').pipe(
        Effect.annotateLogs('cause', Cause.pretty(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.millis(options.pollIntervalMillis))),
    Effect.forever,
  );
