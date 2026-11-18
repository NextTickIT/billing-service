import type { Currency } from '@billing-service/shared';
import { Duration, Effect, Either, Option } from 'effect';

import type { WayForPayClient } from '@/modules/wayforpay/client.js';
import { REASON } from '@/modules/wayforpay/contracts.js';

/**
 * Returning an order's money through WayForPay, as a provider-neutral answer the caller
 * records: `returned`, `refused` (the provider will not, with its code), or `retry` (no
 * answer, or not finished). WayForPay's statuses and codes stay in this module.
 */
export type RefundAttempt =
  | { readonly kind: 'returned' }
  | { readonly kind: 'refused'; readonly reasonCode: string | null }
  | { readonly kind: 'retry'; readonly reason: string };

export interface RefundOrder {
  readonly orderReference: string;
  readonly amount: number; // integer minor units
  readonly currency: Currency;
  readonly comment: string;
}

/** The longest a REFUND call may take. */
export const REFUND_CALL_TIMEOUT_SECONDS = 30;

/** The longest a whole attempt (status check and REFUND) may take. Whoever claims a
 * refund owns it for longer than this (the caller's lease), so an attempt never outlives
 * its claim and a redelivery never overlaps it. */
export const REFUND_ATTEMPT_DEADLINE_SECONDS = 60;

// The documented statuses are capitalised, the documented example is not: compare lowered.
const RETURNED_STATUSES: readonly string[] = ['refunded', 'voided'];
const IN_PROCESSING_STATUS = 'refundinprocessing';

const lowered = (status: string | undefined): string | null =>
  status === undefined ? null : status.toLowerCase();

const reasonText = (value: string | number | undefined): string | null =>
  value === undefined ? null : String(value);

/** A returned order: Refunded or Voided with reasonCode Ok. */
const isReturned = (answer: {
  readonly transactionStatus?: string | undefined;
  readonly reasonCode?: string | number | undefined;
}): boolean => {
  const status = lowered(answer.transactionStatus);
  return (
    status !== null &&
    RETURNED_STATUSES.includes(status) &&
    reasonText(answer.reasonCode) === String(REASON.OK)
  );
};

/** Classify the provider's answer to a REFUND, or the order's CHECK_STATUS. */
export const refundAnswer = (answer: {
  readonly transactionStatus?: string | undefined;
  readonly reasonCode?: string | number | undefined;
}): RefundAttempt => {
  if (isReturned(answer)) return { kind: 'returned' };
  if (lowered(answer.transactionStatus) === IN_PROCESSING_STATUS) {
    return { kind: 'retry', reason: 'RefundInProcessing' };
  }
  return { kind: 'refused', reasonCode: reasonText(answer.reasonCode) };
};

/** What CHECK_STATUS says about an earlier attempt: None when the order still holds the
 * money (the earlier attempt did not return it), else what to record. */
const earlierOutcome = (
  client: Pick<WayForPayClient, 'checkStatus'>,
  orderReference: string,
): Effect.Effect<Option.Option<RefundAttempt>> =>
  client.checkStatus(orderReference).pipe(
    Effect.map((status) => {
      const answer = refundAnswer(status);
      return answer.kind === 'refused' ? Option.none() : Option.some(answer);
    }),
    Effect.catchAll((error) =>
      Effect.succeed(
        Option.some<RefundAttempt>({ kind: 'retry', reason: error._tag }),
      ),
    ),
  );

/** Bound a whole attempt: past the deadline it is an unanswered attempt, and its fiber
 * (with any request in flight) is interrupted, so nothing it does lands after the lease. */
const withinDeadline = (
  attempt: Effect.Effect<RefundAttempt>,
): Effect.Effect<RefundAttempt> =>
  attempt.pipe(
    Effect.timeoutTo({
      duration: Duration.seconds(REFUND_ATTEMPT_DEADLINE_SECONDS),
      onSuccess: (result): RefundAttempt => result,
      onTimeout: (): RefundAttempt => ({
        kind: 'retry',
        reason: 'AttemptDeadline',
      }),
    }),
  );

/**
 * One refund attempt; never fails, every answer is a value. `reconcileFirst`: an earlier
 * attempt may have reached the provider (it ended without an answer, or its worker died),
 * so the order's status is asked first and a REFUND is sent only while it still holds the
 * money. The REFUND itself is a single request with a deadline.
 */
export const attemptRefund = (
  client: Pick<WayForPayClient, 'refund' | 'checkStatus'>,
  order: RefundOrder,
  reconcileFirst: boolean,
): Effect.Effect<RefundAttempt> =>
  withinDeadline(
    Effect.gen(function* () {
      if (reconcileFirst) {
        const earlier = yield* earlierOutcome(client, order.orderReference);
        if (Option.isSome(earlier)) return earlier.value;
      }
      const answer = yield* Effect.either(
        client.refund(order).pipe(
          Effect.timeoutFail({
            duration: Duration.seconds(REFUND_CALL_TIMEOUT_SECONDS),
            onTimeout: () => ({ _tag: 'RefundTimeout' as const }),
          }),
        ),
      );
      return Either.isRight(answer)
        ? refundAnswer(answer.right)
        : { kind: 'retry' as const, reason: answer.left._tag };
    }),
  );

/**
 * Status only, never a REFUND: for a refund whose REFUND budget is spent, the last attempt
 * may still have returned the money. `refused` (code null) means the order still holds it.
 */
export const reconcileRefund = (
  client: Pick<WayForPayClient, 'checkStatus'>,
  orderReference: string,
): Effect.Effect<RefundAttempt> =>
  withinDeadline(
    earlierOutcome(client, orderReference).pipe(
      Effect.map(
        Option.getOrElse((): RefundAttempt => ({
          kind: 'refused',
          reasonCode: null,
        })),
      ),
    ),
  );
