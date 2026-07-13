import { SqlClient } from '@effect/sql';
import { Effect } from 'effect';

/** Readiness probe: the service is healthy only when the database answers a
 * trivial query. An unreachable database surfaces as a failed Effect, which the
 * route turns into a 503 rather than a lying 200. */
export const checkHealth = () =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1`);
