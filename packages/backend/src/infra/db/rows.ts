import { Effect } from 'effect';

/**
 * The single row a `RETURNING` clause must produce. A missing row is a defect (the
 * statement was written to return exactly one), so it dies rather than surfacing a
 * recoverable error. Shared by every repo, not unique to one module.
 */
export const requireRow = <A>(rows: readonly A[]): Effect.Effect<A> => {
  const [row] = rows;
  return row === undefined
    ? Effect.dieMessage('expected a RETURNING row')
    : Effect.succeed(row);
};
