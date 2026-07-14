import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Context, Effect, Layer } from 'effect';

import {
  runDispatcher,
  type DispatcherOptions,
} from '@/infra/queue/dispatcher.js';
import {
  enqueue,
  type EnqueueInput,
  type EnqueueResult,
} from '@/infra/queue/store.js';
import { TaskRegistry } from '@/infra/task-registry.js';

/**
 * Queue — the durable-queue seam (docs/09) as an Effect service. `enqueue` is the
 * one idempotent write every event source uses (webhook, poller, our own charge
 * result); `run` is the worker's dispatch loop, driven by the handlers modules
 * registered on the {@link TaskRegistry}. Requires a `SqlClient`, so it lives in the
 * worker runtime (HTTP routes that need to enqueue call `enqueue(sql)` directly).
 */
export interface QueueService {
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<EnqueueResult, SqlError.SqlError>;
  readonly run: (options: DispatcherOptions) => Effect.Effect<never>;
}

export class Queue extends Context.Tag('Queue')<Queue, QueueService>() {}

export const QueueLive = Layer.effect(
  Queue,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* TaskRegistry;
    return {
      enqueue: enqueue(sql),
      run: (options) =>
        runDispatcher({ sql, handlers: registry.handlers }, options),
    };
  }),
);
