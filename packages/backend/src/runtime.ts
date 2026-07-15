import { Layer, ManagedRuntime } from 'effect';

import type { AppConfig } from '@/config.js';
import { SqlLive } from '@/infra/db.js';
import { HasherLive } from '@/infra/hasher.js';
import { QueueLive } from '@/infra/queue/service.js';
import { rateLimiterLayer } from '@/infra/rate-limiter.js';
import { LoggingSinkLive } from '@/infra/sinks.js';
import { TaskRegistryLive } from '@/infra/task-registry.js';
import { makeAuthConfig } from '@/modules/auth/domain.js';
import { AuthRepoLive } from '@/modules/auth/data-access.js';
import { OutboxLive } from '@/modules/outbox/domain.js';
import { makeCompositeMatcher } from '@/modules/charge/contracts.js';
import { makeChargePipelineLayer } from '@/modules/charge/domain.js';
import { makeCheckoutRepo } from '@/modules/checkout/data-access.js';
import {
  makeCheckoutApplier,
  makeCheckoutMatcher,
} from '@/modules/checkout/domain.js';
import { makeRecurringMatcher } from '@/modules/payment/matcher.js';
import { makePaymentRepo } from '@/modules/payment/data-access.js';
import { WayForPayLive } from '@/modules/wayforpay/client.js';
import { makeW4pConfig } from '@/modules/wayforpay/config.js';

/**
 * The single application runtime (HTTP server): one `Layer` — Hasher + auth config
 * + AuthRepo over the real Postgres connection — behind one `ManagedRuntime`. Every
 * route runs on it. `ManagedRuntime.make` is LAZY: constructing it opens no
 * connection; `PgClient` connects on the first `runtime.run*` (an auth route or the
 * `/health` probe), so `buildApp()` and connection-free unit tests stay hermetic
 * even though `PgClient` connects eagerly once the layer is built.
 */
export const makeAppLayer = (config: AppConfig) =>
  Layer.mergeAll(
    HasherLive,
    makeAuthConfig({
      adminToken: config.adminToken,
      sessionTtlSeconds: config.sessionTtlSeconds,
    }),
    // `provideMerge` keeps `SqlClient` in the runtime's context, so route handlers
    // and the `/health` readiness probe run queries on it directly.
    AuthRepoLive.pipe(Layer.provideMerge(SqlLive(config.database))),
  );

export const makeAppRuntime = (config: AppConfig) =>
  ManagedRuntime.make(makeAppLayer(config));

export type AppRuntime = ReturnType<typeof makeAppRuntime>;

/** The WayForPay client with its config + rate limiter satisfied. */
const wayForPayLayer = (config: AppConfig) =>
  WayForPayLive.pipe(
    Layer.provide(
      makeW4pConfig({
        merchantAccount: config.wayforpay.merchantAccount,
        merchantSecretKey: config.wayforpay.merchantSecretKey,
        merchantPassword: config.wayforpay.merchantPassword,
        apiUrl: config.wayforpay.apiUrl,
        regularApiUrl: config.wayforpay.regularApiUrl,
        merchantDomainName: config.wayforpay.merchantDomainName,
        checkoutUrl: config.wayforpay.checkoutUrl,
        serviceUrl: config.wayforpay.serviceUrl,
        returnUrl: config.wayforpay.returnUrl,
      }),
    ),
    Layer.provide(rateLimiterLayer(config.wayforpay.rateLimitRps)),
  );

/**
 * Worker runtime — the background process (src/worker.ts), a separate OS process
 * with its own runtime. DB-backed: the `Queue` dispatcher and `Outbox` need
 * `SqlClient`, the queue reads the `TaskRegistry` for the handler set, and the
 * outbox fans out to the `Sinks`. Built eagerly on worker start. Layering: base
 * services -> Queue (needs sql + registry) -> Outbox (needs sql + sinks + queue) ->
 * ChargePipeline (needs sql + outbox + queue).
 */
export const makeWorkerLayer = (config: AppConfig) => {
  const base = Layer.mergeAll(
    TaskRegistryLive,
    LoggingSinkLive,
    SqlLive(config.database),
    wayForPayLayer(config),
  );
  // The pipeline's matcher tries checkout (session) then recurring (our charges);
  // its applier creates/extends the subscription. Both are plain functions built
  // from `sql` here at the composition root — legacy _WFPREG charges match nothing
  // and quarantine (the migration tail).
  const pipeline = makeChargePipelineLayer(
    (sql) =>
      makeCompositeMatcher([
        makeCheckoutMatcher(makeCheckoutRepo(sql)),
        makeRecurringMatcher(makePaymentRepo(sql)),
      ]),
    (sql) => makeCheckoutApplier(makePaymentRepo(sql), makeCheckoutRepo(sql)),
  );
  const withQueue = Layer.provideMerge(QueueLive, base);
  const withOutbox = Layer.provideMerge(OutboxLive, withQueue);
  return Layer.provideMerge(pipeline, withOutbox);
};

export const makeWorkerRuntime = (config: AppConfig) =>
  ManagedRuntime.make(makeWorkerLayer(config));

export type WorkerRuntime = ReturnType<typeof makeWorkerRuntime>;
