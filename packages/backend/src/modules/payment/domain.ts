import type { SqlError } from '@effect/sql';
import { PaymentStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addPeriod } from '@/modules/payment/period.js';

/**
 * The billing terms a successful charge establishes for a user (FR-003). The
 * gateway holds at most one active payment per external user, so a charge
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
  /** true when a new payment was created (drives `payment_created`). */
  readonly created: boolean;
}

export const createOrExtend =
  (repo: PaymentRepo) =>
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
        status: PaymentStatus.Active,
        nextChargeDate,
        recurringTokenRef: params.recurringTokenRef,
        firstFailureAt: null,
        retryAttempt: 0,
      });
      return { subscriptionId: created.id, created: true };
    });
