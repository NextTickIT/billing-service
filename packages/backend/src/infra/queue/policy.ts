/**
 * Pure queue policy — the decisions the dispatcher makes about a message, kept
 * free of SQL and the clock so they are exhaustively unit-testable. The store
 * (store.ts) executes what these functions decide; the dispatcher (dispatcher.ts)
 * wires them to real time and handlers.
 *
 * Retry ownership (docs/09 R5): on failure the queue reschedules with a capped
 * exponential backoff until `maxAttempts` is reached, then marks the message
 * terminally `fail`. A richer per-handler policy (a handler returning its own
 * `retryAt`) is a later extension; this is the sane default.
 */

/** Terminal + transitional message states (docs/09 R6). */
export type MessageStatus =
  'pending' | 'in_progress' | 'retry' | 'success' | 'fail';

export interface RetryConfig {
  /** Attempts allowed before a failure becomes terminal (`fail`). */
  readonly maxAttempts: number;
  /** First backoff step. */
  readonly baseMillis: number;
  /** Upper bound on any single backoff step. */
  readonly maxMillis: number;
}

export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 5,
  baseMillis: 1_000,
  maxMillis: 60_000,
};

/**
 * Capped exponential backoff for the Nth attempt (1-based): the delay applied
 * AFTER `attempt` has failed, before the next try. `attempt <= 0` is treated as
 * the first step; every step is clamped to `[baseMillis, maxMillis]`.
 */
export const backoffMillis = (attempt: number, config: RetryConfig): number => {
  const step = Math.max(attempt, 1) - 1;
  const raw = config.baseMillis * 2 ** step;
  return Math.min(raw, config.maxMillis);
};

/** What the store should write when an attempt finishes. */
export interface Outcome {
  readonly status: Extract<MessageStatus, 'success' | 'retry' | 'fail'>;
  /** Set only for `retry`: absolute wall-clock time of the next eligible run. */
  readonly retryAt: Date | null;
  /** Set for the terminal states (`success`/`fail`). */
  readonly finished: boolean;
}

/**
 * Decide a finished attempt's outcome from whether it failed, the attempt number
 * just consumed (post-increment at claim time), and the clock. Success is
 * terminal; a failure retries with backoff until `maxAttempts`, then fails.
 */
export const decideOutcome = (
  params: { readonly failed: boolean; readonly attemptCount: number },
  nowMillis: number,
  config: RetryConfig,
): Outcome => {
  if (!params.failed) {
    return { status: 'success', retryAt: null, finished: true };
  }
  if (params.attemptCount >= config.maxAttempts) {
    return { status: 'fail', retryAt: null, finished: true };
  }
  return {
    status: 'retry',
    retryAt: new Date(nowMillis + backoffMillis(params.attemptCount, config)),
    finished: false,
  };
};

/** Compact, JSON-serializable error shape for the `attempts.error` column. */
export interface ErrorDetail {
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

/** Normalize any thrown/failed value into a stored error detail. */
export const describeError = (error: unknown): ErrorDetail => {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === 'object' && error !== null) {
    const tag = (error as { _tag?: unknown })._tag;
    return {
      message:
        typeof tag === 'string'
          ? tag
          : (safeStringify(error) ?? 'unknown error'),
    };
  }
  return { message: String(error) };
};

const safeStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};
