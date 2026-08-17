import type { SqlError } from '@effect/sql';
import { Effect } from 'effect';

import { Conflict } from '@/infra/http/errors.js';

/** The Postgres SQLSTATE code carried on a driver error, if the cause exposes one. */
export const pgErrorCode = (error: SqlError.SqlError): string | undefined => {
  const { cause } = error;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

/**
 * Map a unique-violation (SQLSTATE 23505) on `field` to a `Conflict`; re-fail any
 * other SqlError unchanged. Generic Postgres handling, not unique to one module.
 */
export const onUniqueViolation =
  (field: string) =>
  (
    error: SqlError.SqlError,
  ): Effect.Effect<never, Conflict | SqlError.SqlError> =>
    pgErrorCode(error) === '23505'
      ? Effect.fail(new Conflict({ field }))
      : Effect.fail(error);
