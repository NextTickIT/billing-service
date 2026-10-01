import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import { Effect, Option, Schema } from 'effect';

/**
 * A Stripe-style idempotency ledger for endpoints that create or additively change state
 * (create a payment, defer a payment) and so are NOT naturally idempotent. The first
 * request under a `(scope, key)` runs the effect and stores its response; a retry — or a
 * concurrent duplicate (a double-clicked operator button, a network re-send) — replays
 * that stored response instead of running the effect again.
 *
 * Correctness rests on ONE transaction per attempt (`withTransaction` below): the claim,
 * the wrapped effect, and the stored response commit together. So a failure rolls the
 * claim back (a later retry proceeds cleanly), and a concurrent duplicate blocks on the
 * claim row until the winner commits — then reads and replays its response. Never a
 * partial write or a double apply.
 */

const claim = (sql: SqlClient.SqlClient, scope: string, key: string) =>
  sql<{ readonly scope: string }>`
    INSERT INTO idempotency_keys (scope, "idemKey")
    VALUES (${scope}, ${key})
    ON CONFLICT (scope, "idemKey") DO NOTHING
    RETURNING scope
  `.pipe(Effect.map((rows) => rows.length > 0));

const storeResponse = (
  sql: SqlClient.SqlClient,
  scope: string,
  key: string,
  response: unknown,
) =>
  sql`
    UPDATE idempotency_keys SET response = ${JSON.stringify(response)}::jsonb
    WHERE scope = ${scope} AND "idemKey" = ${key}
  `.pipe(Effect.asVoid);

const findResponse = (sql: SqlClient.SqlClient, scope: string, key: string) =>
  sql<{ readonly response: unknown }>`
    SELECT response FROM idempotency_keys
    WHERE scope = ${scope} AND "idemKey" = ${key}
  `.pipe(Effect.map((rows) => Option.fromNullable(rows[0]?.response)));

interface LedgerCtx<A, I> {
  readonly scope: string;
  readonly key: string;
  readonly schema: Schema.Schema<A, I>;
}

const replayOrRun = <A, I, E, R>(
  sql: SqlClient.SqlClient,
  ctx: LedgerCtx<A, I>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError.SqlError, R> =>
  Effect.gen(function* () {
    const claimed = yield* claim(sql, ctx.scope, ctx.key);
    if (!claimed) {
      // The claim lost to a prior/concurrent winner; by now it has committed its response
      // (the INSERT above blocked on its row until then), so decode and replay it.
      const prior = yield* findResponse(sql, ctx.scope, ctx.key);
      if (Option.isNone(prior)) {
        return yield* Effect.dieMessage(
          `idempotency response missing for ${ctx.scope}:${ctx.key}`,
        );
      }
      return yield* Schema.decodeUnknown(ctx.schema)(prior.value).pipe(
        Effect.orDie,
      );
    }
    const result = yield* effect;
    const encoded = yield* Schema.encode(ctx.schema)(result).pipe(Effect.orDie);
    yield* storeResponse(sql, ctx.scope, ctx.key, encoded);
    return result;
  });

/**
 * Run `effect` under idempotency `(scope, key)`, or replay the recorded response. A null
 * key (the caller sent no `Idempotency-Key`) opts out — the effect runs directly, exactly
 * as before. `schema` is the endpoint's output schema; the response is stored in its
 * encoded (JSON-safe) form and decoded back on replay, so a `Date` round-trips faithfully.
 */
export const withIdempotencyKey =
  <A, I>(scope: string, key: string | null, schema: Schema.Schema<A, I>) =>
  <E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError.SqlError, R | SqlClient.SqlClient> =>
    key === null
      ? effect
      : Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(replayOrRun(sql, { scope, key, schema }, effect)),
        );
