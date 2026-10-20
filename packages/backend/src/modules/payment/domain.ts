import type { SqlError } from '@effect/sql';
import {
  type CheckoutRenewal,
  type Payment,
  PaymentMethod,
  PaymentStatus,
  scalePeriod,
} from '@billing-service/shared';
import { Effect, Option } from 'effect';

import type {
  AdvanceAnchor,
  PaymentRepo,
} from '@/modules/payment/data-access.js';
import { addDays, addPeriod, samePeriod } from '@/modules/payment/period.js';

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
  /**
   * A one-time bonus period (ISO-8601 duration) granted on top of the paid period, or
   * null. Only a checkout that carried a promo sets it; a recurring renewal never does,
   * so the bonus lands exactly once — on the charge that earned it.
   */
  readonly promoBonus?: string | null;
  /**
   * The terms the scheduler charges from now on, when they differ from this first charge
   * (`amount`/`period`). Stored on the row in their place; the first charge itself is
   * kept in the charge fixation.
   */
  readonly renewal?: CheckoutRenewal | null;
  /** The charge's source; picks the token and method a prolongation keeps (`tokenRule`). */
  readonly source?: string;
  /**
   * How many `period`s this one charge pays for (a multi-cycle manual renewal); 1 when
   * absent. Only the anchors move further, by `period` × cycles as one duration — the
   * same `scalePeriod` the events report, so the access a sink grants ends on the date
   * billing does. `amount`/`period` stay one cycle's terms, so the row keeps renewing
   * at them.
   */
  readonly cycles?: number;
  /**
   * Opaque caller declaration. ABSENT (or null) means leave the stored value alone — only
   * a checkout that actually supplied one re-stamps the payment. See `Metadata`.
   */
  readonly metadata?: Record<string, unknown> | null | undefined;
}

export interface ApplyPaymentResult {
  readonly subscriptionId: string;
  /** true when a new payment was created (drives `payment_created`). */
  readonly created: boolean;
  /** true when the charge stacked onto the user's live recurring payment. */
  readonly prolonged: boolean;
  /** Set on a prolongation that cleared a pending cancel. */
  readonly reactivated?: boolean;
  /**
   * Set when nothing was written because an intro-priced charge met a live payment (Q8):
   * stacking would credit the intro period at the intro price on top of the paid time.
   * `subscriptionId` is that live payment; the caller refuses the settlement.
   */
  readonly introOnLive?: boolean;
  /** The next scheduled charge date established by this charge (the paid-through anchor).
   * Carried out so the succeeded event can report it. */
  readonly nextPaymentDate: Date;
  /** The window this charge bought (promo bonus already folded into the end). */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** What the payment carries after this charge — supplied value, else the stored one. */
  readonly metadata: Record<string, unknown> | null;
}

/** The period a successful charge pays for; the next charge anchors on its end. */
interface PeriodAnchors {
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly nextPaymentDate: Date;
}

const periodAnchors = (params: ApplyPaymentParams): PeriodAnchors => {
  const paidThrough = addPeriod(
    params.paidAt,
    scalePeriod(params.period, params.cycles ?? 1),
  );
  // A promo grants free time ON TOP of the paid period, once: it pushes the paid-through
  // anchor further, and the next charge date derives from that anchor — so the bonus
  // shifts both together and drift stays impossible (CLAUDE.md §6). Applied only here, on
  // the charge that carried the promo; a later renewal has no `promoBonus` and resumes
  // the normal cadence.
  const currentPeriodEnd =
    params.promoBonus != null && params.promoBonus.length > 0
      ? addPeriod(paidThrough, params.promoBonus)
      : paidThrough;
  return {
    currentPeriodStart: params.paidAt,
    currentPeriodEnd,
    nextPaymentDate: currentPeriodEnd,
  };
};

/** Insert a fresh Payment. A one-time payment stores no reusable token (it is never
 * charged again) and is `recurring: false`, so the scheduler — which only selects
 * `recurring = true` rows — never renews it. (Token-less RECURRING payments ARE now
 * picked up: they get a manual-pay prompt instead of an autocharge, docs/28.) */
const insertNew =
  (repo: PaymentRepo) =>
  (
    params: ApplyPaymentParams,
    anchors: PeriodAnchors,
  ): Effect.Effect<ApplyPaymentResult, SqlError.SqlError> =>
    repo
      .insert({
        externalUserId: params.externalUserId,
        // The scheduler charges the renewal terms; the first charge only set the anchors.
        amount: params.renewal?.amount ?? params.amount,
        currency: params.currency,
        method: params.method,
        period: params.renewal?.period ?? params.period,
        status: PaymentStatus.Active,
        recurring: params.recurring,
        ...anchors,
        recurringTokenRef: params.recurring ? params.recurringTokenRef : null,
        firstFailureAt: null,
        retryAttempt: 0,
        metadata: params.metadata ?? null,
      })
      .pipe(
        Effect.map((created) => ({
          subscriptionId: created.id,
          created: true,
          prolonged: false,
          nextPaymentDate: anchors.nextPaymentDate,
          periodStart: anchors.currentPeriodStart,
          periodEnd: anchors.currentPeriodEnd,
          metadata: created.metadata,
        })),
      );

/**
 * The anchors of a period stacked onto a live row: the new end is the old end plus
 * `period`, never `paidAt` plus it, so paid time is never lost. A row still inside its
 * period keeps its start; a row already past its end (PastDue) starts the new period at
 * the old end. No promo: a live contact never stacks free time. Compared by `getTime()`,
 * so equal-valued distinct Dates count as equal. `cycles` stacks `period` × cycles as one
 * duration (see `ApplyPaymentParams.cycles`).
 */
export const stackAnchors = (
  row: Pick<Payment, 'currentPeriodStart' | 'currentPeriodEnd'>,
  period: string,
  paidAt: Date,
  cycles = 1,
): AdvanceAnchor => {
  const end = addPeriod(row.currentPeriodEnd, scalePeriod(period, cycles));
  return {
    currentPeriodStart:
      row.currentPeriodEnd.getTime() <= paidAt.getTime()
        ? row.currentPeriodEnd
        : row.currentPeriodStart,
    currentPeriodEnd: end,
    nextPaymentDate: end,
  };
};

/**
 * The token and method a prolongation leaves on the row, keyed on the charge SOURCE like
 * the card-change applier: WhitePay (crypto) never yields a reusable token, so the row
 * goes manual crypto; a card charge stores the new token when the callback returned one
 * and otherwise keeps the stored one (an Approved WayForPay charge can omit it, docs/14).
 */
export const tokenRule = (
  source: string | undefined,
  newToken: string | null,
  locked: Pick<Payment, 'recurringTokenRef'>,
): { readonly recurringTokenRef: string | null; readonly method: number } =>
  source === 'whitepay_callback'
    ? { recurringTokenRef: null, method: PaymentMethod.Crypto }
    : {
        recurringTokenRef: newToken ?? locked.recurringTokenRef,
        method: PaymentMethod.Card,
      };

/** A payment that still renews: Active, or PastDue inside its retry window. */
export const isLive = (payment: Pick<Payment, 'status'>): boolean =>
  payment.status === PaymentStatus.Active ||
  payment.status === PaymentStatus.PastDue;

/** The contact's live (Active/PastDue) recurring payment, if any. */
export type FindActiveRecurring =
  PaymentRepo['findActiveRecurringByExternalUser'];

/** An intro offer: the first charge differs from the terms it renews on (Q8). */
export const isIntroPriced = (terms: {
  readonly amount: number;
  readonly period: string;
  readonly renewal?: CheckoutRenewal | null;
}): boolean =>
  terms.renewal != null &&
  (terms.renewal.amount !== terms.amount ||
    !samePeriod(terms.renewal.period, terms.period));

/** The result of stacking a charge onto a live row (`stacked` is what `extend` wrote). */
const prolongedResult = (
  row: Payment,
  stacked: AdvanceAnchor,
  supplied: ApplyPaymentParams['metadata'],
): ApplyPaymentResult => ({
  subscriptionId: row.id,
  created: false,
  prolonged: true,
  reactivated: row.cancelRequestedAt !== null,
  nextPaymentDate: stacked.nextPaymentDate,
  periodStart: stacked.currentPeriodStart,
  periodEnd: stacked.currentPeriodEnd,
  // Mirrors what `extend`'s COALESCE just wrote: the supplied declaration, or the stored
  // one when this charge supplied none.
  metadata: supplied ?? row.metadata,
});

/**
 * Apply a successful checkout charge. A one-time charge always inserts. A recurring one
 * stacks onto the user's live (Active/PastDue) recurring payment, re-read under a row
 * lock so a concurrent writer's time is never lost; with no live payment (none, or it
 * died meanwhile) it inserts a fresh, auto-charging one anchored at `paidAt`. An
 * intro-priced charge never stacks: it writes nothing and reports `introOnLive`. Must run in
 * the caller's transaction (the settlement), which holds the lock to commit.
 */
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
      const locked = Option.isSome(existing)
        ? yield* repo.lockById(existing.value.id)
        : Option.none<Payment>();
      if (Option.isSome(locked) && isLive(locked.value)) {
        const row = locked.value;
        // `/pay` refuses an intro link on a live sub, but links claimed before the sub
        // existed still settle here: re-check under the lock, write nothing.
        if (isIntroPriced(params)) {
          return {
            subscriptionId: row.id,
            created: false,
            prolonged: false,
            introOnLive: true,
            nextPaymentDate: row.nextPaymentDate,
            periodStart: row.currentPeriodStart,
            periodEnd: row.currentPeriodEnd,
            metadata: row.metadata,
          };
        }
        // The promo is dropped here: a live contact paying a promo link stacks the paid
        // period only, never free time.
        const stacked = stackAnchors(
          row,
          params.period,
          params.paidAt,
          params.cycles,
        );
        yield* repo.extend(row.id, {
          amount: params.renewal?.amount ?? params.amount,
          currency: params.currency,
          period: params.renewal?.period ?? params.period,
          ...tokenRule(params.source, params.recurringTokenRef, row),
          ...stacked,
          metadata: params.metadata,
        });
        return prolongedResult(row, stacked, params.metadata);
      }
      return yield* insertNew(repo)(params, anchors);
    });

/** What an advance credited: the anchors it wrote, plus the declaration the row carries
 * (an advance never rewrites it), so a succeeded event can report the window it bought. */
export interface AdvancedPeriod extends AdvanceAnchor {
  readonly metadata: Record<string, unknown> | null;
}

/**
 * Credit `period` to a payment from its locked anchor (a renewal or an arrears card
 * change). Locks the row, skips unless `guard` accepts it, then advances by
 * `stackAnchors`, which also resets dunning and sets Active. Runs in the caller's
 * transaction when there is one (as a savepoint), else in its own. Returns what it
 * credited, or None when the row is gone or the guard refused.
 */
export const advanceLocked =
  (repo: PaymentRepo) =>
  (
    id: string,
    period: string,
    at: Date,
    guard: (locked: Payment) => boolean,
  ): Effect.Effect<Option.Option<AdvancedPeriod>, SqlError.SqlError> =>
    repo.transaction(
      Effect.gen(function* () {
        const locked = yield* repo.lockById(id);
        if (Option.isNone(locked) || !guard(locked.value)) {
          return Option.none();
        }
        const anchors = stackAnchors(locked.value, period, at);
        yield* repo.advanceAfterSuccess(id, anchors);
        return Option.some({ ...anchors, metadata: locked.value.metadata });
      }),
    );

/**
 * Deferral (docs/23): grant N free days by pushing the paid-through anchor. The
 * next charge date is re-derived FROM the new anchor (`currentPeriodEnd`), never
 * hand-set — so drift stays structurally impossible (CLAUDE.md §6).
 * Test oracle only: the defer route now uses the relative SQL `defer` (RETURNING the new end).
 */
export const computeDeferral = (
  payment: Payment,
  days: number,
): { newPeriodEnd: Date; newNextPaymentDate: Date } => {
  const newPeriodEnd = addDays(payment.currentPeriodEnd, days);
  return { newPeriodEnd, newNextPaymentDate: newPeriodEnd };
};
