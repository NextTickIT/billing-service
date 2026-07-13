import { Clock, Context, Duration, Effect, Layer, Ref } from 'effect';

/**
 * A uniform leaky-bucket rate limiter: permits are handed out one every
 * `1000 / requestsPerSecond` ms, holding a steady average under a provider's
 * limits (WayForPay documents none, so we stay conservative — NFR-03). Scheduling
 * the next slot is an atomic `Ref.modify` and time comes from `Clock`, so it is
 * both concurrency-safe and testable.
 */
export interface RateLimiter {
  readonly take: Effect.Effect<void>;
  readonly limit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class RateLimiterService extends Context.Tag('RateLimiter')<
  RateLimiterService,
  RateLimiter
>() {}

export const makeRateLimiter = (
  requestsPerSecond: number,
): Effect.Effect<RateLimiter> =>
  Effect.gen(function* () {
    if (!(requestsPerSecond > 0)) {
      return yield* Effect.dieMessage(
        `RateLimiter.requestsPerSecond must be > 0, got ${String(requestsPerSecond)}`,
      );
    }
    const intervalMillis = 1000 / requestsPerSecond;
    // Timestamp from which the next slot is available.
    const nextSlot = yield* Ref.make(0);

    const take: Effect.Effect<void> = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const scheduledAt = yield* Ref.modify(nextSlot, (prev) => {
        const startAt = Math.max(prev, now);
        return [startAt, startAt + intervalMillis] as const;
      });
      const waitMillis = scheduledAt - now;
      if (waitMillis > 0) {
        yield* Effect.sleep(Duration.millis(waitMillis));
      }
    });

    const limit = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => take.pipe(Effect.andThen(effect));

    return { take, limit };
  });

export const rateLimiterLayer = (
  requestsPerSecond: number,
): Layer.Layer<RateLimiterService> =>
  Layer.effect(RateLimiterService, makeRateLimiter(requestsPerSecond));
