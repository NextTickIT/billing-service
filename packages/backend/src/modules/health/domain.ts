import { Effect } from 'effect';

export interface HealthStatus {
  readonly status: 'ok';
}

/**
 * Service as a plain function returning an Effect (no class, no methods).
 * Health is intentionally trivial — it takes no dependencies.
 */
export const checkHealth = (): Effect.Effect<HealthStatus> =>
  Effect.succeed({ status: 'ok' });
