import type { SqlError } from '@effect/sql';
import {
  type Payment,
  PaymentOrigin,
  PaymentStatus,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addDays, addPeriod } from '@/modules/payment/period.js';

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
      const currentPeriodStart = params.paidAt;
      const currentPeriodEnd = addPeriod(params.paidAt, params.period);
      const nextPaymentDate = currentPeriodEnd;
      const existing = yield* repo.findActiveByExternalUser(
        params.externalUserId,
      );
      if (Option.isSome(existing)) {
        // A managed payment is extended in place. An EXTERNAL (legacy) payment is
        // superseded instead: the user is migrating to gateway billing (docs/25
        // §4.4) by paying through our checkout, so we free the single-active slot
        // and fall through to create a fresh managed payment below.
        if (existing.value.origin !== PaymentOrigin.External) {
          yield* repo.extend(existing.value.id, {
            amount: params.amount,
            currency: params.currency,
            method: params.method,
            period: params.period,
            currentPeriodStart,
            currentPeriodEnd,
            nextPaymentDate,
            recurringTokenRef: params.recurringTokenRef,
          });
          return { subscriptionId: existing.value.id, created: false };
        }
        yield* repo.supersede(existing.value.id);
      }
      const created = yield* repo.insert({
        externalUserId: params.externalUserId,
        amount: params.amount,
        currency: params.currency,
        method: params.method,
        period: params.period,
        status: PaymentStatus.Active,
        currentPeriodStart,
        currentPeriodEnd,
        nextPaymentDate,
        recurringTokenRef: params.recurringTokenRef,
        firstFailureAt: null,
        retryAttempt: 0,
      });
      return { subscriptionId: created.id, created: true };
    });

/**
 * Deferral (docs/23): grant N free days by pushing the paid-through anchor. The
 * next charge date is re-derived FROM the new anchor (`currentPeriodEnd`), never
 * hand-set — so drift stays structurally impossible (CLAUDE.md §6).
 */
export const computeDeferral = (
  payment: Payment,
  days: number,
): { newPeriodEnd: Date; newNextPaymentDate: Date } => {
  const newPeriodEnd = addDays(payment.currentPeriodEnd, days);
  return { newPeriodEnd, newNextPaymentDate: newPeriodEnd };
};
