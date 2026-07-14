import { Context, Effect, Layer } from 'effect';

/**
 * TaskRegistry — the in-memory seam where the worker subscribes handlers to message
 * types. It holds only the handler map; the durable queue itself (ingest, claim,
 * retry, status log — docs/09) lives in the `Queue` service (infra/queue), which
 * reads this registry to know what it may claim. Kept dependency-free (no SQL); it
 * lives in the worker runtime, where the worker registers its handlers on startup.
 *
 * "Functions, not classes": the class below is only a Context.Tag identity token;
 * the service implementation is a record of functions.
 */
export type MessageType = string;

export type TaskHandler = (payload: unknown) => Effect.Effect<void, unknown>;

export interface TaskRegistryService {
  readonly register: (
    messageType: MessageType,
    handler: TaskHandler,
  ) => Effect.Effect<void>;
  readonly handlers: () => Effect.Effect<ReadonlyMap<MessageType, TaskHandler>>;
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
  };
});
