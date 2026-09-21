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
  type ManualCheckout,
  paymentManualRequired,
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
  readonly lapse: (sub: Payment) => Effect.Effect<void, SqlError.SqlError>;
  /** Best-effort check that the contact cancelled/quarantined on the SendPulse side
   * (by contact tag). Fail-open: the boot wires any SendPulse error to `false` so a
   * SendPulse outage never stalls real renewals (docs/23). */
  readonly upstreamCancelled: (sub: Payment) => Effect.Effect<boolean>;
  /** Cancel locally because the contact cancelled upstream: flip to cancelled +
   * record payment_cancelled. No charge, no retry ladder. */
  readonly cancelUpstream: (
    sub: Payment,
    now: Date,
  ) => Effect.Effect<void, SqlError.SqlError>;
  /** Mint OUR internal checkout session for a token-less (crypto) renewal and return its
   * link + live window, so the manual-pay prompt can point the user at it (docs/28). */
  readonly createManualCheckout: (
    sub: Payment,
    now: Date,
  ) => Effect.Effect<ManualCheckout, SqlError.SqlError>;
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

/**
 * A token-less (crypto) renewal came due (docs/28): we cannot autocharge, so we prompt the
 * user to pay again at OUR internal checkout. The attempt rides the SAME retry ladder as a
 * card failure — re-prompting on each scheduled date — and the exhausted ladder lapses to
 * `renewal_failed`. Paying the session extends the payment (and a card pay captures a token,
 * graduating it back to autocharge next cycle). We check the ladder BEFORE prompting so the
 * giving-up tick emits only `renewal_failed`, never a fresh prompt.
 */
const promptManual = (deps: SchedulerDeps, sub: Payment, now: Date) =>
  Effect.gen(function* () {
    const firstFailureAt = sub.firstFailureAt ?? now;
    const plan = planRetry(sub.retryAttempt, firstFailureAt);
    if (plan.final || plan.nextPaymentDate === null) {
      yield* deps.subs.markRenewalFailed(sub.id);
      yield* deps.publish(
        renewalFailed(sub, 'manual payment not completed', now),
      );
      return;
    }
    // Still within the ladder: mint our checkout link and prompt. Publish BEFORE
    // recordRetry so the event carries this attempt's due date (recordRetry moves it).
    const checkout = yield* deps.createManualCheckout(sub, now);
    yield* deps.publish(paymentManualRequired(sub, checkout, now));
    yield* deps.subs.recordRetry(sub.id, {
      firstFailureAt,
      retryAttempt: plan.attempt,
      nextPaymentDate: plan.nextPaymentDate,
    });
  });

/** Charge the stored card token and settle the outcome: approve → advance from the
 * anchor + feed the success back through the pipeline; decline → the retry ladder. */
const chargeCard = (deps: SchedulerDeps, sub: Payment, now: Date) =>
  Effect.gen(function* () {
    const orderReference = orderReferenceFor(sub);
    const response = yield* deps.client.charge({
      orderReference,
      amount: sub.amount,
      currency: sub.currency,
      recToken: sub.recurringTokenRef ?? '',
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

const chargeOne = (deps: SchedulerDeps, sub: Payment, now: Date) =>
  Effect.gen(function* () {
    if (sub.cancelRequestedAt !== null) {
      // A soft-cancelled payment lapses at the due date instead of charging —
      // no charge, no retry ladder (docs/23). The lapse is enqueued (not published
      // inline) so the worker-owned outbox emits the terminal event durably.
      yield* deps.lapse(sub);
      return;
    }
    if (yield* deps.upstreamCancelled(sub)) {
      // The contact cancelled/quarantined on the SendPulse side — cancel on our
      // side and never attempt the charge (docs/23). Applies to card AND crypto
      // renewals (checked before the token branch below).
      yield* deps.cancelUpstream(sub, now);
      return;
    }
    if (sub.recurringTokenRef === null) {
      // No reusable token (WhitePay crypto): can't autocharge — prompt the user to pay
      // again at our internal checkout (docs/28) instead.
      return yield* promptManual(deps, sub, now);
    }
    yield* chargeCard(deps, sub, now);
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
  scheduleTick(deps, config).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError('scheduler tick failed').pipe(
        Effect.annotateLogs('cause', Cause.pretty(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.seconds(config.intervalSeconds))),
    Effect.forever,
  );
