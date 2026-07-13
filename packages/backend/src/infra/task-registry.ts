import { Context, Effect, Layer } from 'effect';

/**
 * TaskRegistry — the seam where modules subscribe to "tasks" (the durable
 * Postgres message queue described in docs/09-message_queue_recomendations.md:
 * raw_events -> messages -> attempts, claimed with FOR UPDATE SKIP LOCKED).
 *
 * This is a skeleton: `register` records handlers in memory and `runDispatcher`
 * is a placeholder poll-loop. No SQL and no real consumption yet (no logic).
 *
 * Note on "functions, not classes": the class below is only a Context.Tag
 * identity token; the service implementation is a record of functions.
 */
export type MessageType = string;

export type TaskHandler = (payload: unknown) => Effect.Effect<void>;

export interface TaskRegistryService {
  readonly register: (
    messageType: MessageType,
    handler: TaskHandler,
  ) => Effect.Effect<void>;
  readonly handlers: () => Effect.Effect<ReadonlyMap<MessageType, TaskHandler>>;
  readonly runDispatcher: () => Effect.Effect<never>;
}

export class TaskRegistry extends Context.Tag('TaskRegistry')<
  TaskRegistry,
  TaskRegistryService
>() {}

export const TaskRegistryLive = Layer.sync(TaskRegistry, () => {
  const handlers = new Map<MessageType, TaskHandler>();
  return {
    register: (messageType, handler) =>
      Effect.sync(() => {
        handlers.set(messageType, handler);
      }),
    handlers: () => Effect.sync(() => handlers),
    runDispatcher: () =>
      Effect.logInfo(
        'TaskRegistry dispatcher poll-loop skeleton (docs/09) — not implemented',
      ).pipe(Effect.andThen(Effect.never)),
  };
});
