import type { SqlError } from '@effect/sql';
import { type Payment, PaymentStatus } from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type { PaymentRepo } from '@/modules/payment/data-access.js';
import { addDays, addPeriod } from '@/modules/payment/period.js';

/**
 * The billing terms a successful charge establishes for a user (FR-003). A recurring
 * charge either creates the user's payment or extends the existing one (at most one
 * active recurring payment per user). A one-time charge (`recurring: false`) is always
 * a fresh record — never extended, never capped — so a user may hold any number of
 * them alongside a recurring payment. The next charge is the payment date plus period.
 */
export interface ApplyPaymentParams {
  readonly externalUserId: string;
  readonly amount: number;
  readonly currency: number;
  readonly method: number;
  readonly period: string;
  readonly recurring: boolean;
  readonly recurringTokenRef: string | null;
  readonly paidAt: Date;
}

export interface ApplyPaymentResult {
  readonly subscriptionId: string;
  /** true when a new payment was created (drives `payment_created`). */
  readonly created: boolean;
}

/** The period a successful charge pays for; the next charge anchors on its end. */
interface PeriodAnchors {
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly nextPaymentDate: Date;
}

const periodAnchors = (params: ApplyPaymentParams): PeriodAnchors => {
  const currentPeriodEnd = addPeriod(params.paidAt, params.period);
  return {
    currentPeriodStart: params.paidAt,
    currentPeriodEnd,
    nextPaymentDate: currentPeriodEnd,
  };
};

/** Insert a fresh Payment. A one-time payment stores no reusable token (it is never
 * charged again), so the scheduler — which requires a token — can never pick it up. */
const insertNew =
  (repo: PaymentRepo) =>
  (
    params: ApplyPaymentParams,
    anchors: PeriodAnchors,
  ): Effect.Effect<ApplyPaymentResult, SqlError.SqlError> =>
    repo
      .insert({
        externalUserId: params.externalUserId,
        amount: params.amount,
        currency: params.currency,
        method: params.method,
        period: params.period,
        status: PaymentStatus.Active,
        recurring: params.recurring,
        ...anchors,
        recurringTokenRef: params.recurring ? params.recurringTokenRef : null,
        firstFailureAt: null,
        retryAttempt: 0,
      })
      .pipe(
        Effect.map((created) => ({
          subscriptionId: created.id,
          created: true,
        })),
      );

export const createOrExtend =
  (repo: PaymentRepo) =>
  (
    params: ApplyPaymentParams,
  ): Effect.Effect<ApplyPaymentResult, SqlError.SqlError> =>
    Effect.gen(function* () {
      const anchors = periodAnchors(params);
      // A one-time payment never extends and never collapses into the user's recurring
      // payment — always a new record, with no per-user cap.
      if (!params.recurring) {
        return yield* insertNew(repo)(params, anchors);
      }
      const existing = yield* repo.findActiveRecurringByExternalUser(
        params.externalUserId,
      );
      if (Option.isSome(existing)) {
        yield* repo.extend(existing.value.id, {
          amount: params.amount,
          currency: params.currency,
          method: params.method,
          period: params.period,
          ...anchors,
          recurringTokenRef: params.recurringTokenRef,
        });
        return { subscriptionId: existing.value.id, created: false };
      }
      return yield* insertNew(repo)(params, anchors);
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
