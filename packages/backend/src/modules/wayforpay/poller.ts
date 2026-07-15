import type { SqlError } from '@effect/sql';
import { Cause, Clock, Duration, Effect } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import type { W4pError } from '@/modules/wayforpay/errors.js';
import { mapTransaction } from '@/modules/wayforpay/mapping.js';
import type { PollerStateRepo } from '@/modules/wayforpay/poller-state.js';
import { chunkWindows, type DateWindow } from '@/modules/wayforpay/windows.js';

/**
 * The FR-008 migration poller (docs/15). It reads the WayForPay journal over a
 * sliding, overlapping window and turns payment rows into standard incoming events
 * (M2 pipeline) — it never writes payments or domain events itself (D4). The loop
 * is crash-resilient: a failed tick is logged and the next tick retries; the
 * watermark only advances after a window is fully ingested, so a crash re-reads the
 * overlap (idempotent).
 */
export interface PollerDeps {
  readonly client: Pick<WayForPayClient, 'transactionList'>;
  readonly ingest: (
    event: Charge,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly state: PollerStateRepo;
}

export interface PollerConfig {
  readonly account: string;
  readonly pollIntervalSeconds: number;
  readonly windowOverlapSeconds: number;
  readonly maxWindowSeconds: number;
}

/** First-run lookback when there is no watermark yet (docs/15 OQ4). */
const BOOTSTRAP_LOOKBACK_SECONDS = 24 * 60 * 60;

/**
 * The window for a tick: from `watermark - overlap` (absorbing late arrivals) up
 * to now, but never more than `maxWindow` per tick so a long outage catches up in
 * bounded steps rather than one huge query.
 */
export const computeWindow = (
  watermark: number | null,
  nowSeconds: number,
  config: Pick<PollerConfig, 'windowOverlapSeconds' | 'maxWindowSeconds'>,
): DateWindow => {
  const start = watermark ?? nowSeconds - BOOTSTRAP_LOOKBACK_SECONDS;
  return {
    dateBegin: start - config.windowOverlapSeconds,
    dateEnd: Math.min(nowSeconds, start + config.maxWindowSeconds),
  };
};

const ingestRows = (
  deps: PollerDeps,
  rows: readonly Parameters<typeof mapTransaction>[0][],
): Effect.Effect<number, SqlError.SqlError> => {
  const events = rows
    .map(mapTransaction)
    .filter((event): event is Charge => event !== null);
  return Effect.forEach(events, deps.ingest, { discard: true }).pipe(
    Effect.as(events.length),
  );
};

export interface TickResult {
  readonly ingested: number;
  readonly skipped: number;
}

/** One poll: read the window, ingest payment rows, advance the watermark. */
export const pollTick = (
  deps: PollerDeps,
  config: PollerConfig,
): Effect.Effect<TickResult, W4pError | SqlError.SqlError> =>
  Effect.gen(function* () {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const watermark = yield* deps.state.getWatermark(config.account);
    const window = computeWindow(
      watermark._tag === 'Some' ? watermark.value : null,
      nowSeconds,
      config,
    );
    const rows = yield* deps.client.transactionList(window);
    const ingested = yield* ingestRows(deps, rows);
    yield* deps.state.upsertWatermark(config.account, window.dateEnd);
    return { ingested, skipped: rows.length - ingested };
  });

/** The steady-state loop: tick, log, sleep, repeat forever — resilient to faults. */
export const runPoller = (
  deps: PollerDeps,
  config: PollerConfig,
): Effect.Effect<never> =>
  pollTick(deps, config)
    .pipe(
      Effect.tap((result) =>
        Effect.logInfo('w4p poller tick').pipe(
          Effect.annotateLogs({
            ingested: result.ingested,
            skipped: result.skipped,
          }),
        ),
      ),
      Effect.catchAllCause((cause) =>
        Effect.logError('w4p poller tick failed').pipe(
          Effect.annotateLogs('cause', Cause.pretty(cause)),
        ),
      ),
    )
    .pipe(
      Effect.andThen(
        Effect.sleep(Duration.seconds(config.pollIntervalSeconds)),
      ),
      Effect.forever,
    );

export interface BackfillResult {
  readonly ingested: number;
  readonly deepestReached: number;
}

/**
 * Operator-triggered historical backfill (docs/15 OQ4): walk `[from, to]` newest
 * first in ≤30-day chunks, reusing the same ingest path. Stops after
 * `emptyChunkLimit` consecutive empty chunks (retention depth is unknown), so it
 * doesn't scan arbitrarily far into an empty past.
 */
export const backfill = (
  deps: PollerDeps,
  fromSeconds: number,
  toSeconds: number,
  emptyChunkLimit = 2,
): Effect.Effect<BackfillResult, W4pError | SqlError.SqlError> =>
  Effect.gen(function* () {
    const windows = chunkWindows(fromSeconds, toSeconds).reverse();
    let ingested = 0;
    let consecutiveEmpty = 0;
    let deepestReached = toSeconds;
    for (const window of windows) {
      const rows = yield* deps.client.transactionList(window);
      ingested += yield* ingestRows(deps, rows);
      deepestReached = window.dateBegin;
      consecutiveEmpty = rows.length === 0 ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= emptyChunkLimit) {
        break;
      }
    }
    return { ingested, deepestReached };
  });
