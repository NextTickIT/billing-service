import { Effect } from 'effect';

import { TaskRegistry } from '@/infra/task-registry.js';
import { makeRuntime } from '@/runtime.js';

const runtime = makeRuntime();

await runtime.runPromise(
  Effect.gen(function* () {
    yield* Effect.logInfo('worker started');
    const registry = yield* TaskRegistry;
    yield* registry.runDispatcher();
  }),
);
