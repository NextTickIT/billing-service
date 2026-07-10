import { Context, type Effect } from 'effect';

/**
 * Data-access contract for the health module — interface only, no queries.
 * A real implementation would be a Layer backed by the @effect/sql-pg client.
 */
export interface HealthRepository {
  readonly ping: () => Effect.Effect<boolean>;
}

export class HealthRepo extends Context.Tag('HealthRepo')<
  HealthRepo,
  HealthRepository
>() {}
