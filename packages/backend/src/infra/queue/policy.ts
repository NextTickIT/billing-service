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
  /**
   * An explicit schedule: the Nth entry is the delay after attempt N fails. When set
   * it replaces the doubling; build it with {@link scheduledRetryConfig} so
   * `maxAttempts` always matches its length.
   */
  readonly delaysMillis?: readonly number[];
  /**
   * Extra random wait, as a fraction of the step (0.2 = up to +20%). Messages that
   * failed together during one outage then spread out instead of retrying as one
   * burst against a receiver that is just coming back. Absent = no jitter.
   */
  readonly jitterRatio?: number;
}

export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 5,
  baseMillis: 1_000,
  maxMillis: 60_000,
};

/** A config that retries once per entry of `delaysMillis`, then fails. */
export const scheduledRetryConfig = (
  delaysMillis: readonly number[],
): RetryConfig => {
  // A bad entry would write an Invalid Date or a past `retryAt`: refuse it at boot.
  if (
    delaysMillis.length === 0 ||
    !delaysMillis.every((d) => Number.isFinite(d) && d >= 0)
  ) {
    throw new Error(
      `retry schedule needs finite, non-negative delays: ${JSON.stringify(delaysMillis)}`,
    );
  }
  return {
    maxAttempts: delaysMillis.length + 1,
    baseMillis: Math.min(...delaysMillis),
    maxMillis: Math.max(...delaysMillis),
    delaysMillis,
  };
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Event deliveries (`deliver_event`) outlive a receiver outage: the last retry runs
 * ~31 h after the first failure. With the default ~15 s ladder, a few hours of
 * SendPulse answering 400 on 2026-10-18 dead-lettered four paid renewals for good.
 * Every wait is a `retryAt` on the queue row, so a pending retry survives restarts.
 */
export const deliveryRetryConfig: RetryConfig = {
  ...scheduledRetryConfig([
    10 * SECOND,
    MINUTE,
    10 * MINUTE,
    HOUR,
    2 * HOUR,
    4 * HOUR,
    8 * HOUR,
    16 * HOUR,
  ]),
  jitterRatio: 0.2,
};

/**
 * Delay applied AFTER the Nth attempt (1-based) has failed, before the next try:
 * the Nth entry of `delaysMillis` when the config has a schedule (the last entry
 * past its end), else capped doubling clamped to `[baseMillis, maxMillis]`.
 * `attempt <= 0` is treated as the first step.
 */
export const backoffMillis = (attempt: number, config: RetryConfig): number => {
  const step = Math.max(attempt, 1) - 1;
  const scheduled = config.delaysMillis;
  if (scheduled !== undefined && scheduled.length > 0) {
    return scheduled[Math.min(step, scheduled.length - 1)] ?? config.maxMillis;
  }
  const raw = config.baseMillis * 2 ** step;
  return Math.min(raw, config.maxMillis);
};

/** The step plus its jitter, floored so the extra stays strictly below the ratio. */
const withJitter = (
  attempt: number,
  config: RetryConfig,
  random: number,
): number => {
  const step = backoffMillis(attempt, config);
  return step + Math.floor(step * (config.jitterRatio ?? 0) * random);
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
 * terminal; a failure retries with backoff until `maxAttempts`, then fails. A
 * `permanent` failure fails on this attempt: re-running it cannot succeed, and each
 * re-run only delays the dead letter an operator has to see.
 */
export const decideOutcome = (
  params: {
    readonly failed: boolean;
    readonly attemptCount: number;
    readonly permanent?: boolean;
  },
  nowMillis: number,
  config: RetryConfig,
  /** A draw in [0, 1) that picks this retry's jitter; 0 = none. */
  random = 0,
): Outcome => {
  if (!params.failed) {
    return { status: 'success', retryAt: null, finished: true };
  }
  if (params.permanent === true || params.attemptCount >= config.maxAttempts) {
    return { status: 'fail', retryAt: null, finished: true };
  }
  return {
    status: 'retry',
    retryAt: new Date(
      nowMillis + withJitter(params.attemptCount, config, random),
    ),
    finished: false,
  };
};

/**
 * Did the handler declare this failure permanent? Structural (`permanent: true` on the
 * failure value) so the queue stays free of any one handler's error types; `SinkError`
 * sets it for an answer the receiver will never accept.
 */
export const isPermanentFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly permanent?: unknown }).permanent === true;

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
