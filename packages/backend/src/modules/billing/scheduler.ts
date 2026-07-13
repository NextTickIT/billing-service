import type { SqlError } from '@effect/sql';
import type { DomainEvent, Subscription } from '@billing-service/shared';
import { Cause, Clock, Duration, Effect } from 'effect';

import type { IncomingPaymentEvent } from '@/modules/payments/contracts.js';
import type { SubscriptionRepo } from '@/modules/subscription/data-access.js';
import { addPeriod } from '@/modules/subscription/period.js';
import { planRetry } from '@/modules/subscription/retry.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import {
  chargeIncomingEvent,
  chargeRetryFailed,
  renewalFailed,
} from '@/modules/billing/events.js';

/**
 * The recurring billing scheduler (docs/00 §5.3, FR-004/005/006). Each tick finds
 * due subscriptions and charges the stored token. Success advances the next charge
 * and feeds the result through the pipeline (payment + payment_succeeded); failure
 * walks the fixed 0/1/3/5/7 retry ladder, emitting charge_retry_failed and finally
 * renewal_failed. The orderReference is deterministic per attempt, so a crash-retry
 * is a no-op at WayForPay (duplicate ref) and in our pipeline (idem key).
 */
export interface SchedulerDeps {
  readonly subs: SubscriptionRepo;
  readonly client: Pick<WayForPayClient, 'charge'>;
  readonly ingest: (
    event: IncomingPaymentEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export interface SchedulerConfig {
  readonly intervalSeconds: number;
  readonly batchSize: number;
}

/** Deterministic per attempt: the timestamp changes only when the schedule moves. */
const orderReferenceFor = (sub: Subscription): string =>
  `sub_${sub.id}_${sub.nextChargeDate.getTime().toString()}`;

const onFailure = (
  deps: SchedulerDeps,
  sub: Subscription,
  reason: string,
  now: Date,
) =>
  Effect.gen(function* () {
    const firstFailureAt = sub.firstFailureAt ?? now;
    const plan = planRetry(sub.retryAttempt, firstFailureAt);
    if (plan.final || plan.nextChargeDate === null) {
      yield* deps.subs.markRenewalFailed(sub.id);
      yield* deps.publish(renewalFailed(sub, reason, now));
      return;
    }
    yield* deps.subs.recordRetry(sub.id, {
      firstFailureAt,
      retryAttempt: plan.attempt,
      nextChargeDate: plan.nextChargeDate,
    });
    yield* deps.publish(
      chargeRetryFailed(
        sub,
        { attempt: plan.attempt, nextRetryDate: plan.nextChargeDate, reason },
        now,
      ),
    );
  });

const chargeOne = (deps: SchedulerDeps, sub: Subscription, now: Date) =>
  Effect.gen(function* () {
    if (sub.recurringTokenRef === null) {
      return; // no token on file — nothing to charge (findDue filters these out)
    }
    const orderReference = orderReferenceFor(sub);
    const response = yield* deps.client.charge({
      orderReference,
      amount: sub.amount,
      currency: sub.currency,
      recToken: sub.recurringTokenRef,
      orderDate: Math.floor(now.getTime() / 1000),
      productName: `Subscription ${sub.period}`,
    });
    if (response.transactionStatus === 'Approved') {
      yield* deps.subs.advanceAfterSuccess(
        sub.id,
        addPeriod(sub.nextChargeDate, sub.period),
      );
      yield* deps.ingest(
        chargeIncomingEvent(sub, orderReference, response, now),
      );
      return;
    }
    yield* onFailure(deps, sub, response.reason ?? 'charge declined', now);
  });

export const scheduleTick = (
  deps: SchedulerDeps,
  config: SchedulerConfig,
): Effect.Effect<number, SqlError.SqlError> =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    const due = yield* deps.subs.findDue(now, config.batchSize);
    // Isolate each subscription: one failed charge must not abort the batch.
    yield* Effect.forEach(
      due,
      (sub) =>
        chargeOne(deps, sub, now).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('scheduler: charge failed').pipe(
              Effect.annotateLogs({
                subscriptionId: sub.id,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      { discard: true },
    );
    return due.length;
  });

export const runScheduler = (
  deps: SchedulerDeps,
  config: SchedulerConfig,
): Effect.Effect<never> =>
  scheduleTick(deps, config)
    .pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError('scheduler tick failed').pipe(
          Effect.annotateLogs('cause', Cause.pretty(cause)),
        ),
      ),
    )
    .pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(config.intervalSeconds))),
      Effect.forever,
    );
