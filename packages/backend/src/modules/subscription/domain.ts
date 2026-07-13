import type { SqlError } from '@effect/sql';
import { SubscriptionStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { SubscriptionRepo } from '@/modules/subscription/data-access.js';
import { addPeriod } from '@/modules/subscription/period.js';

/**
 * The billing terms a successful payment establishes for a user (FR-003). The
 * gateway holds at most one active subscription per external user, so a payment
 * either creates it or extends the existing one — the next charge is always the
 * payment date plus the period.
 */
export interface ApplyPaymentParams {
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: number;
  readonly method: number;
  readonly period: string;
  readonly recurringTokenRef: string | null;
  readonly paidAt: Date;
}

export interface ApplyPaymentResult {
  readonly subscriptionId: string;
  /** true when a new subscription was created (drives `subscription_created`). */
  readonly created: boolean;
}

export const createOrExtend =
  (repo: SubscriptionRepo) =>
  (
    params: ApplyPaymentParams,
  ): Effect.Effect<ApplyPaymentResult, SqlError.SqlError> =>
    Effect.gen(function* () {
      const nextChargeDate = addPeriod(params.paidAt, params.period);
      const existing = yield* repo.findActiveByExternalUser(
        params.externalUserId,
      );
      if (Option.isSome(existing)) {
        yield* repo.extend(existing.value.id, {
          amount: params.amount,
          currency: params.currency,
          method: params.method,
          period: params.period,
          nextChargeDate,
          recurringTokenRef: params.recurringTokenRef,
        });
        return { subscriptionId: existing.value.id, created: false };
      }
      const created = yield* repo.insert({
        externalUserId: params.externalUserId,
        amount: params.amount,
        currency: params.currency,
        method: params.method,
        period: params.period,
        status: SubscriptionStatus.Active,
        nextChargeDate,
        recurringTokenRef: params.recurringTokenRef,
        firstFailureAt: null,
        retryAttempt: 0,
      });
      return { subscriptionId: created.id, created: true };
    });
