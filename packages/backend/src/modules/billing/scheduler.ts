import type { SqlError } from '@effect/sql';
import type { DomainEvent, Payment } from '@billing-service/shared';
import { Cause, Clock, Duration, Effect } from 'effect';

import type { Charge } from '@/modules/charge/contracts.js';
import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod } from '@/modules/payment/period.js';
import { planRetry } from '@/modules/payment/retry.js';
import { PAYMENT_ORDER_PREFIX } from '@/modules/payment/matcher.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import {
  chargeIncomingEvent,
  chargeRetryFailed,
  renewalFailed,
} from '@/modules/billing/events.js';

/**
 * The recurring billing scheduler (docs/00 §5.3, FR-004/005/006). Each tick finds
 * due payments and charges the stored token. Success advances the next charge
 * from the period ANCHOR (`currentPeriodEnd`), never the retry date — this is the
 * drift fix (AC-8). Failure walks the fixed 0/1/3/5/7 retry ladder.
 */
export interface SchedulerDeps {
  readonly subs: PaymentRepo;
  readonly client: Pick<WayForPayClient, 'charge'>;
  readonly ingest: (event: Charge) => Effect.Effect<void, SqlError.SqlError>;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export interface SchedulerConfig {
  readonly intervalSeconds: number;
  readonly batchSize: number;
}

/** Deterministic per attempt: the timestamp changes only when the schedule moves. */
const orderReferenceFor = (sub: Payment): string =>
  `${PAYMENT_ORDER_PREFIX}${sub.id}_${sub.nextPaymentDate.getTime().toString()}`;

const onFailure = (
  deps: SchedulerDeps,
  sub: Payment,
  reason: string,
  now: Date,
) =>
  Effect.gen(function* () {
    const firstFailureAt = sub.firstFailureAt ?? now;
    const plan = planRetry(sub.retryAttempt, firstFailureAt);
    if (plan.final || plan.nextPaymentDate === null) {
      yield* deps.subs.markRenewalFailed(sub.id);
      yield* deps.publish(renewalFailed(sub, reason, now));
      return;
    }
    yield* deps.subs.recordRetry(sub.id, {
      firstFailureAt,
      retryAttempt: plan.attempt,
      nextPaymentDate: plan.nextPaymentDate,
    });
    yield* deps.publish(
      chargeRetryFailed(
        sub,
        { attempt: plan.attempt, nextRetryDate: plan.nextPaymentDate, reason },
        now,
      ),
    );
  });

const chargeOne = (deps: SchedulerDeps, sub: Payment, now: Date) =>
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
      productName: `Payment ${sub.period}`,
    });
    if (response.transactionStatus === 'Approved') {
      const newEnd = addPeriod(sub.currentPeriodEnd, sub.period);
      yield* deps.subs.advanceAfterSuccess(sub.id, {
        currentPeriodStart: sub.currentPeriodEnd,
        currentPeriodEnd: newEnd,
        nextPaymentDate: newEnd,
      });
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
    // Isolate each payment: one failed charge must not abort the batch.
    yield* Effect.forEach(
      due,
      (sub) =>
        chargeOne(deps, sub, now).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('scheduler: charge failed').pipe(
              Effect.annotateLogs({
                paymentId: sub.id,
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
