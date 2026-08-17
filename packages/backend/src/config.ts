import { Redacted } from 'effect';

/**
 * Application configuration shape and loader.
 * Values come from the environment; the DB host defaults to the
 * project-specific loopback (see README / docker-compose).
 */
/**
 * Postgres TLS setting. `false` disables SSL (local dev). The object form maps
 * onto `pg`'s `ssl` (a `tls.ConnectionOptions`): a managed provider (DO) refuses
 * plaintext, so production sets `DB_SSL=require` — encrypt without CA verification
 * (fine over a private VPC) — or `DB_SSL=verify-full` with `DB_CA_CERT` to validate
 * the provider's chain.
 */
export type DatabaseSsl =
  false | { readonly rejectUnauthorized: boolean; readonly ca?: string };

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: DatabaseSsl;
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
  /**
   * Standalone Card Verify (wiki 852189, docs/23/24): the 0-amount tokenization
   * used by a proactive card change. Off until the specific method is confirmed
   * enabled on the merchant account (recToken issuance itself is already live).
   */
  readonly cardVerifyEnabled: boolean;
  /**
   * Fallback for an ACTIVE card change when `cardVerifyEnabled` is false: re-tokenize
   * via a minimal tokenizing Purchase of this many MINOR units instead of a 0-amount
   * Card Verify. 0 attempts a free charge; 1 = 0.01 UAH. The card-change applier
   * rewrites the token WITHOUT advancing the period (an active payment is not owing).
   */
  readonly cardChangeChargeMinor: number;
  readonly pollIntervalSeconds: number;
  readonly windowOverlapSeconds: number;
  readonly maxWindowSeconds: number;
  /** Hosted checkout page the Purchase form posts to. */
  readonly checkoutUrl: string;
  /** Card Verify (0-amount tokenization) endpoint the server POSTs JSON to. */
  readonly verifyUrl: string;
  /** serviceUrl (our callback) and returnUrl (browser) sent with a Purchase. */
  readonly serviceUrl: string;
  readonly returnUrl: string;
  /** Checkout session lifetime before it expires. */
  readonly sessionTtlSeconds: number;
}

/** Recurring-charge scheduler (FR-004). Off until production credentials exist. */
export interface SchedulerConfig {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly batchSize: number;
}

/**
 * In-process background worker toggle. When `true`, the HTTP server process ALSO
 * boots the queue worker (dispatch loop + poller/scheduler) in-process, so a single
 * container both serves the API and drains the queue. When `false` (default) the
 * worker runs only as its own OS process (`dist/worker.js`). Both share the same
 * image; only the launch config differs.
 */
export interface WorkerConfig {
  readonly enabled: boolean;
}

/**
 * Sinks (docs/21): how long the DB-backed `Sinks` service caches config before a
 * re-read (so operator changes are live within the TTL, no restart), plus the
 * SendPulse connector's endpoint and client-side rate limit.
 */
export interface SinksConfig {
  readonly cacheTtlMillis: number;
  readonly sendpulse: {
    readonly apiUrl: string;
    readonly rateLimitRps: number;
  };
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
  readonly scheduler: SchedulerConfig;
  readonly worker: WorkerConfig;
  readonly sinks: SinksConfig;
  /**
   * Shared secret the BFF sends on every proxied request (`BFF_SECRET` env).
   * Empty string disables the gate (development / test). When set, the gate
   * rejects any request to the BFF-proxied surface that lacks the header.
   */
  readonly bffSecret: Redacted.Redacted;
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

/** Checkout knobs (Purchase page + callback URLs), split out for the same reason. */
const loadW4pCheckoutConfig = () => ({
  checkoutUrl:
    process.env['W4P_CHECKOUT_URL'] ?? 'https://secure.wayforpay.com/pay',
  verifyUrl:
    process.env['W4P_VERIFY_URL'] ?? 'https://secure.wayforpay.com/verify',
  serviceUrl: process.env['W4P_SERVICE_URL'] ?? '',
  returnUrl:
    process.env['W4P_RETURN_URL'] ??
    'https://bill.nexttick.it/checkout/{orderReference}/return',
  sessionTtlSeconds: Number(process.env['W4P_SESSION_TTL_SECONDS'] ?? '3600'),
});

const loadSchedulerConfig = (): SchedulerConfig => ({
  enabled: process.env['SCHEDULER_ENABLED'] === 'true',
  intervalSeconds: Number(process.env['SCHEDULER_INTERVAL_SECONDS'] ?? '300'),
  batchSize: Number(process.env['SCHEDULER_BATCH_SIZE'] ?? '100'),
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
  cardVerifyEnabled: process.env['W4P_CARD_VERIFY_ENABLED'] === 'true',
  cardChangeChargeMinor: Number(
    process.env['W4P_CARD_CHANGE_CHARGE_MINOR'] ?? '0',
  ),
  ...loadW4pPollerConfig(),
  ...loadW4pCheckoutConfig(),
});

/** TLS from `DB_SSL` (`disable` | `require` | `verify-full`, default `disable`).
 * `verify-full` validates the chain and so needs `DB_CA_CERT`; without a CA we can
 * only encrypt (`rejectUnauthorized: false`) — the managed-Postgres `require` mode. */
const loadDbSsl = (): DatabaseSsl => {
  const mode = process.env['DB_SSL'] ?? 'disable';
  if (mode === 'disable' || mode === 'false' || mode === '') {
    return false;
  }
  const ca = process.env['DB_CA_CERT'];
  if (ca !== undefined && ca.length > 0) {
    return { rejectUnauthorized: mode === 'verify-full', ca };
  }
  return { rejectUnauthorized: false };
};

const loadDatabaseConfig = (): DatabaseConfig => ({
  host: process.env['DB_HOST'] ?? 'billing-service.local',
  port: Number(process.env['DB_PORT'] ?? '5432'),
  user: process.env['DB_USER'] ?? 'billing',
  password: process.env['DB_PASSWORD'] ?? 'billing',
  database: process.env['DB_NAME'] ?? 'billing',
  ssl: loadDbSsl(),
});

export const loadConfig = (): AppConfig => ({
  host: process.env['HOST'] ?? '0.0.0.0',
  port: Number(process.env['PORT'] ?? '3000'),
  database: loadDatabaseConfig(),
  adminToken: Redacted.make(process.env['ADMIN_TOKEN'] ?? ''),
  sessionTtlSeconds: Number(process.env['SESSION_TTL_SECONDS'] ?? '86400'),
  queue: loadQueueConfig(),
  wayforpay: loadWayForPayConfig(),
  scheduler: loadSchedulerConfig(),
  worker: { enabled: process.env['WORKER_ENABLED'] === 'true' },
  sinks: {
    cacheTtlMillis: Number(process.env['SINKS_CACHE_TTL_MS'] ?? '10000'),
    sendpulse: {
      apiUrl:
        process.env['SENDPULSE_API_URL'] ??
        'https://api.sendpulse.com/telegram',
      rateLimitRps: Number(process.env['SENDPULSE_RATE_LIMIT_RPS'] ?? '5'),
    },
  },
  bffSecret: Redacted.make(process.env['BFF_SECRET'] ?? ''),
});
