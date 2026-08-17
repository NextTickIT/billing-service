import { Duration, Effect, Schedule } from 'effect';

/**
 * Retry policy for transient HTTP failures: one transient blip out of thousands
 * of calls must not fail a whole poll/backfill. Exponential backoff with jitter
 * (base 1s, factor 2, 4 retries); jitter spreads a thundering herd. Only errors
 * the `isTransient` predicate accepts are retried — a 4xx (bar 429) is a client
 * error and retrying it is pointless.
 */
export const isTransientStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

const httpRetrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.millis(1000), 2).pipe(Schedule.jittered),
  Schedule.recurs(4),
);

export const retryTransient = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isTransient: (error: E) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, { schedule: httpRetrySchedule, while: isTransient });
