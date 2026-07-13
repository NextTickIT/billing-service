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

/** WayForPay credentials + endpoints (env-sourced). `merchantPassword` is empty
 * until the regularApi credential is provisioned; on the test merchant the shared
 * demo secret is enough to exercise reads. */
export interface WayForPayConfig {
  readonly merchantAccount: string;
  readonly merchantSecretKey: Redacted.Redacted;
  readonly merchantPassword: Redacted.Redacted;
  readonly apiUrl: string;
  readonly regularApiUrl: string;
  readonly merchantDomainName: string;
  /** Client-side request rate (req/s); WayForPay documents no server limit. */
  readonly rateLimitRps: number;
  /** Migration poller (docs/15): off until production credentials are provisioned. */
  readonly pollerEnabled: boolean;
  readonly pollIntervalSeconds: number;
  readonly windowOverlapSeconds: number;
  readonly maxWindowSeconds: number;
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
  readonly wayforpay: WayForPayConfig;
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

/** Poller knobs split out to keep each loader under the complexity budget. */
const loadW4pPollerConfig = () => ({
  pollerEnabled: process.env['W4P_POLLER_ENABLED'] === 'true',
  pollIntervalSeconds: Number(
    process.env['W4P_POLL_INTERVAL_SECONDS'] ?? '120',
  ),
  windowOverlapSeconds: Number(
    process.env['W4P_WINDOW_OVERLAP_SECONDS'] ?? '900',
  ),
  maxWindowSeconds: Number(process.env['W4P_MAX_WINDOW_SECONDS'] ?? '21600'),
});

const loadWayForPayConfig = (): WayForPayConfig => ({
  merchantAccount: process.env['W4P_MERCHANT_ACCOUNT'] ?? '',
  merchantSecretKey: Redacted.make(process.env['W4P_SECRET_KEY'] ?? ''),
  merchantPassword: Redacted.make(process.env['W4P_MERCHANT_PASSWORD'] ?? ''),
  apiUrl: process.env['W4P_API_URL'] ?? 'https://api.wayforpay.com/api',
  regularApiUrl:
    process.env['W4P_REGULAR_API_URL'] ??
    'https://api.wayforpay.com/regularApi',
  merchantDomainName: process.env['W4P_DOMAIN_NAME'] ?? '',
  rateLimitRps: Number(process.env['W4P_RATE_LIMIT_RPS'] ?? '2'),
  ...loadW4pPollerConfig(),
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
  wayforpay: loadWayForPayConfig(),
});
