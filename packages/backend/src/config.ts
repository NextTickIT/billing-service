import { Redacted } from 'effect';

/**
 * Application configuration shape and loader.
 * Values come from the environment; the DB host defaults to the
 * project-specific loopback (see README / docker-compose).
 */
export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/** Worker message-queue tuning (docs/09). Consumed only by the worker runtime. */
export interface QueueConfig {
  /** Poll cadence between dispatch ticks. */
  readonly pollIntervalMillis: number;
  /** Max messages claimed per tick. */
  readonly batchSize: number;
  /** An `in_progress` message older than this is reaped back to `retry`. */
  readonly visibilityTimeoutMillis: number;
  /** Failed attempts allowed before a message is terminally `fail`. */
  readonly maxAttempts: number;
}

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly database: DatabaseConfig;
  /** Bootstrap admin credential (env `ADMIN_TOKEN`); hash-verified, never stored. */
  readonly adminToken: Redacted.Redacted;
  /** Session lifetime in seconds (env `SESSION_TTL_SECONDS`, default 24h). */
  readonly sessionTtlSeconds: number;
  readonly queue: QueueConfig;
}

/** Queue tuning is its own loader so `loadConfig` stays simple (one concern each). */
const loadQueueConfig = (): QueueConfig => ({
  pollIntervalMillis: Number(process.env['QUEUE_POLL_INTERVAL_MS'] ?? '1000'),
  batchSize: Number(process.env['QUEUE_BATCH_SIZE'] ?? '10'),
  visibilityTimeoutMillis: Number(
    process.env['QUEUE_VISIBILITY_TIMEOUT_MS'] ?? '300000',
  ),
  maxAttempts: Number(process.env['QUEUE_MAX_ATTEMPTS'] ?? '5'),
});

export const loadConfig = (): AppConfig => ({
  host: process.env['HOST'] ?? '0.0.0.0',
  port: Number(process.env['PORT'] ?? '3000'),
  database: {
    host: process.env['DB_HOST'] ?? 'billing-service.local',
    port: Number(process.env['DB_PORT'] ?? '5432'),
    user: process.env['DB_USER'] ?? 'billing',
    password: process.env['DB_PASSWORD'] ?? 'billing',
    database: process.env['DB_NAME'] ?? 'billing',
  },
  adminToken: Redacted.make(process.env['ADMIN_TOKEN'] ?? ''),
  sessionTtlSeconds: Number(process.env['SESSION_TTL_SECONDS'] ?? '86400'),
  queue: loadQueueConfig(),
});
