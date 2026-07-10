import { Effect } from 'effect';

import { Database } from '@/infra/db.js';

export interface HealthStatus {
  readonly status: 'ok';
}

/**
 * Domain logic as a plain function returning an Effect (no class, no methods).
 * Depends on the Database service via the Effect context (R = Database).
 */
export const checkHealth = (): Effect.Effect<HealthStatus, never, Database> =>
  Effect.map(Database, (): HealthStatus => ({ status: 'ok' }));
