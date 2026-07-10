import { Layer, ManagedRuntime } from 'effect';

import { DatabaseLive } from '@/infra/db.js';
import { TaskRegistryLive } from '@/infra/task-registry.js';

/** Composed application layer (Effect DI). Interfaces/wiring only. */
export const AppLayer = Layer.mergeAll(DatabaseLive, TaskRegistryLive);

export type AppRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Layer.Success<typeof AppLayer>,
  never
>;

export const makeRuntime = (): AppRuntime => ManagedRuntime.make(AppLayer);
