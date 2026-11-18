import { SqlClient } from '@effect/sql';
import type { SqlError } from '@effect/sql';
import {
  type CardCheckRefundFailedEvent,
  type CheckoutSession,
  CurrencySchema,
  type DomainEvent,
} from '@billing-service/shared';
import { Clock, Data, Duration, Effect, Option, Schema } from 'effect';

import { scheduledRetryConfig } from '@/infra/queue/policy.js';
import {
  claimVerifyRefund,
  failVerifyRefund,
  makeCheckoutRepo,
  releaseVerifyRefund,
  reviveOwedRefunds,
  settleVerifyRefund,
  type VerifyRefundClaim,
  verifyRefundStateOf,
} from '@/modules/checkout/data-access.js';
import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import {
  attemptRefund,
  reconcileRefund,
  REFUND_ATTEMPT_DEADLINE_SECONDS,
  type RefundAttempt,
} from '@/modules/wayforpay/refund.js';

/**
 * The refund a `charge_refund` card check owes (plan wfp-card-check-charge-refund §6): the
 * settlement enqueues it in the transaction that saw the approved verify charge, and this
 * task returns the money through the provider. One task per order (the queue key); one
 * REFUND call at a time per order (the session's `in_flight` claim); and after any attempt
 * that ended without an answer, the order's status is asked before another REFUND goes out.
 */
export const CARD_CHECK_REFUND = 'card_check_refund';

export const refundTaskKey = (orderReference: string): string =>
  `card_check_refund:${orderReference}`;

/** The queue payload: whose money, which order, how much (minor units) in what. */
export const CardCheckRefundTask = Schema.Struct({
  checkoutSessionId: Schema.String,
  orderReference: Schema.String,
  amount: Schema.Int,
  currency: CurrencySchema,
});

export type CardCheckRefundTask = Schema.Schema.Type<
  typeof CardCheckRefundTask
>;

/**
 * Claimed attempts that may send a REFUND. Counted on the session
 * (`verifyRefundAttempts`), so it survives restarts and queue revivals; a run that failed
 * in the database before claiming spends none. A claim past it only asks the order's
 * status — the last REFUND may have gone through — and then settles or tells support
 * (`card_check_refund_failed`); it never sends another REFUND.
 */
export const CARD_CHECK_REFUND_MAX_ATTEMPTS = 6;

/**
 * Status-only claims after the REFUND budget before support is told anyway. A status that
 * stays unreadable, or a refund WayForPay keeps "in processing" (waiting for merchant
 * funds), would otherwise be asked about forever and never reported. Past this the refund
 * is `failed` with `outcomeUncertain`: support checks the provider before refunding by
 * hand, and a later provider Refunded row still settles it.
 */
export const CARD_CHECK_REFUND_RECONCILE_ATTEMPTS = 6;

/** Why support is told: the provider's refusal, and whether the money may be back. */
export interface RefundVerdict {
  readonly reasonCode: string | null;
  readonly outcomeUncertain: boolean;
}

/** How long a claim owns the refund: twice the attempt deadline, so an attempt never
 * outlives its claim, yet soon enough to take over a dead worker's. */
export const CARD_CHECK_REFUND_LEASE_SECONDS =
  2 * REFUND_ATTEMPT_DEADLINE_SECONDS;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * The queue's retries: about five hours over the first six tries, long enough for a
 * provider outage, short enough that support hears of an unreturned dollar the same day.
 * The queue's budget is not the refund's: when it runs out first (database trouble), the
 * sweep (`runCardCheckRefundSweep`) revives the task.
 */
export const cardCheckRefundRetryConfig = scheduledRetryConfig([
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  HOUR,
  4 * HOUR,
  4 * HOUR,
  4 * HOUR,
  4 * HOUR,
]);

const REFUND_COMMENT = 'Card verification refund';

/** A refund attempt that may succeed if made again (no answer, or not finished). */
export class RefundRetry extends Data.TaggedError('RefundRetry')<{
  readonly orderReference: string;
  readonly reason: string;
}> {}

/** The refund is owed but another delivery owns it, or is about to run it: wait, without
 * spending the queue's budget. */
export class RefundClaimed extends Data.TaggedError('RefundClaimed')<{
  readonly orderReference: string;
}> {
  readonly waiting = true;
}

export const cardCheckRefundFailed = (
  task: CardCheckRefundTask,
  session: CheckoutSession,
  verdict: RefundVerdict,
  at: Date,
): CardCheckRefundFailedEvent => ({
  id: `evt_card_check_refund_failed:${task.orderReference}`,
  name: 'card_check_refund_failed',
  occurredAt: at,
  correlationId: refundTaskKey(task.orderReference),
  externalUserId: session.externalUserId,
  aggregateId: session.id,
  payload: {
    orderReference: task.orderReference,
    amount: task.amount,
    currency: task.currency,
    reasonCode: verdict.reasonCode,
    outcomeUncertain: verdict.outcomeUncertain,
    checkoutSessionId: session.id,
    metadata: session.metadata,
  },
});

export interface CardCheckRefundDeps {
  readonly sql: SqlClient.SqlClient;
  readonly client: Pick<WayForPayClient, 'refund' | 'checkStatus'>;
  readonly publish: (
    event: DomainEvent,
  ) => Effect.Effect<void, SqlError.SqlError>;
}

interface Owned {
  readonly task: CardCheckRefundTask;
  readonly claim: VerifyRefundClaim;
}

/** Give up: mark the refund failed and tell support, once, in one transaction, only
 * while this claim still owns it. A failure here rolls both back; the queue runs it again. */
const giveUp = (
  deps: CardCheckRefundDeps,
  { task, claim }: Owned,
  verdict: RefundVerdict,
) =>
  deps.sql.withTransaction(
    Effect.gen(function* () {
      const session = yield* makeCheckoutRepo(deps.sql).findById(claim.id);
      if (Option.isNone(session)) return;
      if (!(yield* failVerifyRefund(deps.sql)(claim))) return;
      const at = new Date(yield* Clock.currentTimeMillis);
      yield* deps.publish(
        cardCheckRefundFailed(task, session.value, verdict, at),
      );
      yield* Effect.logError('CARD_CHECK_REFUND_FAILED').pipe(
        Effect.annotateLogs({
          sessionId: claim.id,
          orderReference: task.orderReference,
          amount: task.amount,
          reasonCode: verdict.reasonCode,
          outcomeUncertain: verdict.outcomeUncertain,
          attempt: claim.attempt,
        }),
      );
    }),
  );

/** The money is back: settled whoever owns the claim, since that is the provider's fact. */
const settled = (deps: CardCheckRefundDeps, { task, claim }: Owned) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((ms) =>
      settleVerifyRefund(deps.sql)(claim.id, new Date(ms)),
    ),
    Effect.andThen(
      Effect.logInfo('CARD_CHECK_REFUNDED').pipe(
        Effect.annotateLogs({
          sessionId: claim.id,
          orderReference: task.orderReference,
        }),
      ),
    ),
  );

/** The last claim that may still ask: past it, an unanswered attempt is reported. */
const LAST_CLAIM =
  CARD_CHECK_REFUND_MAX_ATTEMPTS + CARD_CHECK_REFUND_RECONCILE_ATTEMPTS;

/** Write what the attempt established. An unanswered one hands the refund back to
 * `pending` and fails, so the queue runs the next attempt after its backoff — until the
 * last claim, which reports it as a failure whose outcome is uncertain. */
const record = (
  deps: CardCheckRefundDeps,
  owned: Owned,
  result: RefundAttempt,
): Effect.Effect<void, SqlError.SqlError | RefundRetry> => {
  switch (result.kind) {
    case 'returned':
      return settled(deps, owned);
    case 'refused':
      return giveUp(deps, owned, {
        reasonCode: result.reasonCode,
        outcomeUncertain: false,
      });
    case 'retry':
      return owned.claim.attempt >= LAST_CLAIM
        ? giveUp(deps, owned, { reasonCode: null, outcomeUncertain: true })
        : releaseVerifyRefund(deps.sql)(owned.claim).pipe(
            Effect.andThen(
              Effect.fail(
                new RefundRetry({
                  orderReference: owned.task.orderReference,
                  reason: result.reason,
                }),
              ),
            ),
          );
  }
};

/** Nothing to claim. Settled or failed (or never owed): done. Still owed (another
 * delivery owns it, or just handed it back): wait and look again, never drop it. */
const unclaimed = (deps: CardCheckRefundDeps, task: CardCheckRefundTask) =>
  Effect.gen(function* () {
    const state = yield* verifyRefundStateOf(deps.sql)(task.checkoutSessionId);
    if (
      Option.isSome(state) &&
      (state.value === 'in_flight' || state.value === 'pending')
    ) {
      return yield* Effect.fail(
        new RefundClaimed({ orderReference: task.orderReference }),
      );
    }
    yield* Effect.logInfo('CARD_CHECK_REFUND_SETTLED').pipe(
      Effect.annotateLogs({ sessionId: task.checkoutSessionId }),
    );
  });

/** Claim one attempt, then refund (or, past the budget, only ask), then record. */
const runAttempt = (deps: CardCheckRefundDeps, task: CardCheckRefundTask) =>
  Effect.gen(function* () {
    const claimed = yield* claimVerifyRefund(deps.sql)(
      task.checkoutSessionId,
      CARD_CHECK_REFUND_LEASE_SECONDS,
    );
    if (Option.isNone(claimed)) return yield* unclaimed(deps, task);
    const owned = {
      task,
      claim: { id: task.checkoutSessionId, attempt: claimed.value },
    };
    const result =
      claimed.value > CARD_CHECK_REFUND_MAX_ATTEMPTS
        ? yield* reconcileRefund(deps.client, task.orderReference)
        : yield* attemptRefund(
            deps.client,
            {
              orderReference: task.orderReference,
              amount: task.amount,
              currency: task.currency,
              comment: REFUND_COMMENT,
            },
            claimed.value > 1,
          );
    yield* record(deps, owned, result);
  });

/** The `card_check_refund` handler. */
export const cardCheckRefundHandler =
  (deps: CardCheckRefundDeps) =>
  (
    payload: unknown,
  ): Effect.Effect<void, SqlError.SqlError | RefundRetry | RefundClaimed> =>
    Schema.decodeUnknown(CardCheckRefundTask)(payload).pipe(
      Effect.catchTag('ParseError', (error) =>
        Effect.die(`invalid ${CARD_CHECK_REFUND} payload: ${error.message}`),
      ),
      Effect.flatMap((task) => runAttempt(deps, task)),
    );

const SWEEP_BATCH = 100;

/** One sweep pass: revive the tasks of refunds still owed that the queue gave up on. */
export const sweepOwedRefunds = (sql: SqlClient.SqlClient) =>
  reviveOwedRefunds(sql)(CARD_CHECK_REFUND, SWEEP_BATCH);

/** The sweep, forever, every `intervalSeconds`; a failed pass is logged and the next runs. */
export const runCardCheckRefundSweep = (
  sql: SqlClient.SqlClient,
  intervalSeconds: number,
): Effect.Effect<never> =>
  sweepOwedRefunds(sql).pipe(
    Effect.tap((revived) =>
      revived > 0
        ? Effect.logWarning(
            'CARD_CHECK_REFUND_SWEEP revived owed refunds',
          ).pipe(Effect.annotateLogs({ revived }))
        : Effect.void,
    ),
    Effect.catchAllCause((cause) =>
      Effect.logError('card-check refund sweep failed').pipe(
        Effect.annotateLogs('cause', String(cause)),
      ),
    ),
    Effect.andThen(Effect.sleep(Duration.seconds(intervalSeconds))),
    Effect.forever,
  );
