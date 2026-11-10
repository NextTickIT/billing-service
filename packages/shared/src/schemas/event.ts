import { Schema } from 'effect';

import { ChargeKind } from '@/schemas/charge.js';
import { CurrencySchema, Metadata } from '@/schemas/payment.js';

/**
 * Outgoing domain events must reach each connected sink within this many seconds
 * (delivery SLA). Owned by the event slice; see docs/07-events.md.
 */
export const SINK_DELIVERY_SLA_SECONDS = 60;

/**
 * The event vocabulary (docs/07 / 00 §6) — the EXTERNAL contract carried to every
 * sink, so the names are strings, not the numeric enums used for stored-at-rest
 * values.
 */
export const EVENT_NAMES = [
  'initial_payment_succeeded',
  'recurring_payment_succeeded',
  'one_time_purchase_succeeded',
  'initial_payment_failed',
  'recurring_payment_failed',
  'charge_retry_failed',
  'charge_deferred',
  'renewal_failed',
  'payment_manual_required',
  'upcoming_charge',
  'payment_created',
  'payment_cancelled',
  'payment_reactivated',
  'payment_deferred',
  'method_changed',
  'external_user_id_changed',
  'card_change_succeeded',
  'card_change_failed',
  'payment_refunded',
  'unknown_payment_quarantined',
] as const;

export const EventName = Schema.Literal(...EVENT_NAMES);

export type EventName = Schema.Schema.Type<typeof EventName>;

/**
 * The envelope every event shares (docs/07). `occurredAt` is UTC; `correlationId`
 * ties an event to the work that produced it; `aggregateId` is the subject
 * (subscription / quarantine). `name`, `externalUserId`, and `payload` are fixed
 * per event by the discriminated union below.
 */
const envelope = {
  id: Schema.String,
  // The dedupe surface, separate from `id` (the identity a sink reads as `event_id` and
  // live flows branch on). Optional at construction: every event's key equals its id
  // today, so the outbox defaults it rather than making all seventeen constructors repeat
  // themselves. A constructor sets it only when an event must collapse on something its
  // identity does not describe. Always present by the time a sink sees it.
  idempotencyKey: Schema.optional(Schema.String),
  occurredAt: Schema.Date,
  correlationId: Schema.String,
  aggregateId: Schema.String,
};

/**
 * A successful payment, split by scenario so downstream flows can differ: an INITIAL
 * (recurring) checkout payment, a RECURRING renewal charge, or a ONE-TIME purchase (a
 * checkout the caller marked non-recurring — a single buy, never renewed). All three
 * carry the same facts; the pipeline picks the variant from the match kind ('checkout'
 * vs 'recurring') and, for checkout, the session's `recurring` flag. A matched incoming
 * event or an operator bind produces one of these.
 */
const succeededPayload = {
  amount: Schema.Int,
  currency: CurrencySchema,
  method: Schema.Int,
  period: Schema.String,
  // The path that brought the charge in (`wayforpay_charge`, `_callback`, `_poller`, …).
  // Not what started it: that is `chargeKind`.
  source: Schema.String,
  chargeKind: ChargeKind,
  // ISO-8601 date of the next scheduled charge; null for a one-time purchase (never
  // renews). A string (not Schema.Date) to match the payload-date convention used by
  // `payment_deferred.newPeriodEnd` / `charge_retry_failed.nextRetryDate`.
  nextPaymentDate: Schema.NullOr(Schema.String),
  // How many cycles of the subscription's terms a multi-cycle (manual renewal) checkout
  // bought; absent when the charge was not such a purchase. `amount` is then the total
  // charged and `period` the time bought, `cycles` × the subscription's period.
  cycles: Schema.optional(Schema.Int),
  // The payment's paid-through coverage AFTER this charge (docs/07). `periodEnd` is the new
  // end. `periodStart` is where the continuous coverage ending there began. For a charge
  // that opens a fresh window (a first payment, or a renewal paid at or after the old end)
  // that is where this charge's own slice starts. For a charge stacked onto time still
  // running (paid early, a prolong), it is the EARLIER start of the whole stacked
  // coverage, not the old end. This charge's own slice is then [previous `periodEnd`,
  // `periodEnd`]. `period` says how long a slice was bought, not where it sits; the slice
  // also outgrows `period` when a promo adds bonus days.
  // ISO-8601 instants, per the payload-date convention. Null where no window is known —
  // an operator bind reconciling a legacy payment has no schedule to report.
  periodStart: Schema.NullOr(Schema.String),
  periodEnd: Schema.NullOr(Schema.String),
  // Whether this payment renews. A one-time purchase and a subscription's first charge
  // otherwise look alike apart from the event name.
  recurring: Schema.Boolean,
  // The caller's own declaration of what was bought (see `Metadata`), echoed unchanged.
  // Null when no checkout ever supplied one.
  metadata: Schema.NullOr(Metadata),
};

export const InitialPaymentSucceededEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('initial_payment_succeeded'),
  externalUserId: Schema.String,
  payload: Schema.Struct(succeededPayload),
});

export type InitialPaymentSucceededEvent = Schema.Schema.Type<
  typeof InitialPaymentSucceededEvent
>;

export const RecurringPaymentSucceededEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('recurring_payment_succeeded'),
  externalUserId: Schema.String,
  payload: Schema.Struct(succeededPayload),
});

export type RecurringPaymentSucceededEvent = Schema.Schema.Type<
  typeof RecurringPaymentSucceededEvent
>;

export const OneTimePurchaseSucceededEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('one_time_purchase_succeeded'),
  externalUserId: Schema.String,
  payload: Schema.Struct(succeededPayload),
});

export type OneTimePurchaseSucceededEvent = Schema.Schema.Type<
  typeof OneTimePurchaseSucceededEvent
>;

/** The facts of a declined checkout payment, shared by the initial and recurring
 * variants. */
const checkoutFailedPayload = {
  amount: Schema.Int,
  currency: CurrencySchema,
  method: Schema.Int,
  period: Schema.String,
  reason: Schema.String,
  source: Schema.String,
  // As on the success variants.
  cycles: Schema.optional(Schema.Int),
};

/**
 * A first (checkout) payment that was DECLINED for a known session (FR-003).
 * Unlike a recurring failure there is no retry ladder — the customer re-initiates
 * a new checkout — so this is a single terminal signal, not a step on the 0/1/3/5/7
 * schedule. `reason` carries the provider decline text/code for the outgoing flow.
 */
export const InitialPaymentFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('initial_payment_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct(checkoutFailedPayload),
});

export type InitialPaymentFailedEvent = Schema.Schema.Type<
  typeof InitialPaymentFailedEvent
>;

/**
 * A checkout that would have EXTENDED an existing subscription was declined: a
 * `/prolong` link, a checkout paid against a live sub, or a manual (crypto) renewal.
 * Same facts as `initial_payment_failed`; the subscription is untouched and the link
 * stays payable, so this is a signal to retry, not a step on the scheduler's ladder.
 * `aggregateId` is the subscription the payment was meant to extend.
 */
export const RecurringPaymentFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('recurring_payment_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct(checkoutFailedPayload),
});

export type RecurringPaymentFailedEvent = Schema.Schema.Type<
  typeof RecurringPaymentFailedEvent
>;

/**
 * A brand-new gateway payment created from a first checkout payment. `method` is how it
 * was paid and therefore how it renews — a card autocharges, crypto takes a manual
 * prompt (`payment_manual_required`) — so the event that states what the payment costs
 * per period also states how that money is taken. `amount`/`period` are the FIRST
 * charge (its total and the time it bought); `renewal` carries the terms later renewals
 * use when the checkout set them (null when it did not, so renewals repeat the first
 * charge).
 */
export const PaymentCreatedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_created'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    amount: Schema.Int,
    currency: CurrencySchema,
    method: Schema.Int,
    period: Schema.String,
    renewal: Schema.NullOr(
      Schema.Struct({ amount: Schema.Int, period: Schema.String }),
    ),
    // As on the success variants: a multi-cycle first charge reports its total and the
    // time it bought; the payment itself renews at one cycle's terms.
    cycles: Schema.optional(Schema.Int),
    // The caller's own declaration of what was bought (see `Metadata`), echoed unchanged
    // from the checkout that created this payment. Null when the caller supplied none.
    metadata: Schema.NullOr(Metadata),
  }),
});

export type PaymentCreatedEvent = Schema.Schema.Type<
  typeof PaymentCreatedEvent
>;

/** A recurring charge that failed but is still inside the retry window (FR-005). */
export const ChargeRetryFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('charge_retry_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    attempt: Schema.Int,
    nextRetryDate: Schema.String,
    reason: Schema.String,
  }),
});

export type ChargeRetryFailedEvent = Schema.Schema.Type<
  typeof ChargeRetryFailedEvent
>;

/**
 * A due charge held back because the payer pressed Pay on the prolong session just
 * before the tick: the scheduler gives the claimed session `graceSeconds` to settle
 * instead of charging. `dueDate` is the original `nextPaymentDate`, `sessionId` the
 * claimed prolong session, `claimedAt` when Pay was pressed. Dates are ISO-8601 strings
 * (payload-date convention).
 */
export const ChargeDeferredEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('charge_deferred'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    paymentId: Schema.String,
    method: Schema.Int,
    dueDate: Schema.String,
    deferredUntil: Schema.String,
    graceSeconds: Schema.Int,
    sessionId: Schema.String,
    claimedAt: Schema.String,
  }),
});

export type ChargeDeferredEvent = Schema.Schema.Type<
  typeof ChargeDeferredEvent
>;

/** The retry schedule is exhausted; the subscription stops renewing (FR-005). */
export const RenewalFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('renewal_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ reason: Schema.String }),
});

export type RenewalFailedEvent = Schema.Schema.Type<typeof RenewalFailedEvent>;

/**
 * A recurring charge came due for a payment WITHOUT a usable token — WhitePay crypto has
 * no reusable token, so it can't be auto-charged (docs/28). Instead of charging, we mint
 * OUR internal checkout session and fire this event so the user can pay again (crypto or
 * card) at `checkoutUrl`. Recurring cycles only — the initial payment is already a manual
 * checkout. `dueDate`/`windowExpiresAt` are ISO-8601 strings (payload-date convention).
 */
export const PaymentManualRequiredEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_manual_required'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    amount: Schema.Int,
    currency: CurrencySchema,
    method: Schema.Int,
    paymentId: Schema.String,
    checkoutUrl: Schema.String,
    dueDate: Schema.String,
    windowExpiresAt: Schema.String,
    /**
     * Which prompt in the retry ladder this is, same meaning as
     * `charge_retry_failed.attempt`. A token-less renewal re-prompts on each scheduled
     * date, so without it every prompt looks identical to a flow — it cannot escalate
     * the wording as the ladder runs out, and the customer gets the same message two or
     * three times with no sign the last one is the last.
     */
    attempt: Schema.Int,
    /**
     * The next date on the ladder, same meaning as `charge_retry_failed.nextRetryDate`:
     * when the customer is reminded again, or, on the last reminder, the day the renewal
     * is marked failed. `dueDate` is THIS prompt and `windowExpiresAt` is how long the
     * link stays live; neither says when the customer will be asked again, so without
     * this a flow could not say "we will remind you on the 5th".
     */
    nextRetryDate: Schema.String,
    /**
     * The cycle counts the linked page offers (`[1]` when it offers only this one). A
     * flow can say "pay for 3 months at once" only when 3 is among them.
     */
    cycleOptions: Schema.Array(Schema.Int),
  }),
});

export type PaymentManualRequiredEvent = Schema.Schema.Type<
  typeof PaymentManualRequiredEvent
>;

/**
 * A scheduled charge is coming up, fired once per notice offset (e.g. 3 days and 1 day
 * before) so the customer is told before money moves rather than after.
 *
 * Advance notice only — it never charges and never moves a date. Retry attempts are
 * deliberately NOT announced: a retry is a failure being worked through, and telling
 * someone "we will charge you tomorrow" mid-ladder is both noise and, if the ladder
 * gives up first, a lie. `chargeDate` is an ISO-8601 string (payload-date convention);
 * the SendPulse sink renders `chargeDate_formatted` / `period_formatted` for the
 * message itself.
 *
 * `method` is what is about to happen, not a detail: a card payment is money leaving an
 * account by itself, a crypto one is a manual payment the customer must make, so a
 * notice that cannot tell the two apart cannot be worded correctly.
 */
export const UpcomingChargeEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('upcoming_charge'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    paymentId: Schema.String,
    amount: Schema.Int,
    currency: CurrencySchema,
    method: Schema.Int,
    period: Schema.String,
    chargeDate: Schema.String,
    /** How many days before `chargeDate` this notice is for — lets a flow branch. */
    noticeDays: Schema.Int,
    /** Pay-now link: a prolong session at this sub's terms, locked to its method. Null when the
     * sub's rail cannot take a payment now (crypto while WhitePay is off). */
    checkoutUrl: Schema.NullOr(Schema.String),
    /** Cycle counts the linked page offers; `[]` when there is no link. */
    cycleOptions: Schema.Array(Schema.Int),
  }),
});

export type UpcomingChargeEvent = Schema.Schema.Type<
  typeof UpcomingChargeEvent
>;

/** A payment cancelled by an operator or a provider event (FR-012). */
export const PaymentCancelledEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_cancelled'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ reason: Schema.String }),
});

export type PaymentCancelledEvent = Schema.Schema.Type<
  typeof PaymentCancelledEvent
>;

/**
 * A cancel request reversed inside the grace window (docs/23): the operator
 * un-cancelled before the period lapsed, so the next scheduled charge proceeds
 * as normal. Tells the access owner to reverse the earlier `payment_cancelled`.
 */
export const PaymentReactivatedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_reactivated'),
  externalUserId: Schema.String,
  payload: Schema.Struct({}),
});

export type PaymentReactivatedEvent = Schema.Schema.Type<
  typeof PaymentReactivatedEvent
>;

/**
 * An operator granted N free days (docs/23): the paid period was extended, so
 * the access owner should extend access to `newPeriodEnd`. `days` is the grant
 * size for the audit trail.
 */
export const PaymentDeferredEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_deferred'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    newPeriodEnd: Schema.String,
    days: Schema.Int,
  }),
});

export type PaymentDeferredEvent = Schema.Schema.Type<
  typeof PaymentDeferredEvent
>;

/**
 * A subscription's payment method changed WITHOUT a payment (docs/32): the
 * no-payment flip of an up-to-date subscription to crypto (card token dropped, crypto
 * recorded). The paid method-change paths already emit a payment event; this fills the
 * one branch that mutates the payment but takes no money. `method` is the new method.
 */
export const MethodChangedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('method_changed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ method: Schema.Int }),
});

export type MethodChangedEvent = Schema.Schema.Type<typeof MethodChangedEvent>;

/**
 * A SendPulse-initiated card change tokenized (verify) or collected (owed) the
 * new card (docs/23). `method` is the payment method used.
 */
export const CardChangeSucceededEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('card_change_succeeded'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ method: Schema.Int }),
});

export type CardChangeSucceededEvent = Schema.Schema.Type<
  typeof CardChangeSucceededEvent
>;

/** A card-change attempt that the provider declined/errored (docs/23). */
export const CardChangeFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('card_change_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ reason: Schema.String }),
});

export type CardChangeFailedEvent = Schema.Schema.Type<
  typeof CardChangeFailedEvent
>;

/**
 * The provider returned money for an order that had settled a payment (docs/34). One
 * refund per order: the id is keyed on the order, so the callback copy and the poller
 * copy of the same refund collapse in the outbox. `aggregateId` is the payment the
 * reversed charge was fixed to and `externalUserId` the user that charge was fixed to.
 * The payment itself is not changed. `amount` is what the provider reported on the
 * refund, in minor units; `originalEventId` is the id of the reversed success event.
 */
export const PaymentRefundedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_refunded'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    amount: Schema.Int.pipe(Schema.nonNegative()),
    currency: CurrencySchema,
    source: Schema.String,
    orderReference: Schema.String,
    originalEventId: Schema.String,
    reason: Schema.optional(Schema.String),
  }),
});

export type PaymentRefundedEvent = Schema.Schema.Type<
  typeof PaymentRefundedEvent
>;

/**
 * An incoming payment that matched no recurrent payment (FR-009).
 * `externalUserId` is null by definition — the user is unknown until an operator
 * binds it.
 */
export const UnknownPaymentQuarantinedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('unknown_payment_quarantined'),
  externalUserId: Schema.Null,
  payload: Schema.Struct({
    quarantineId: Schema.String,
    incomingEventId: Schema.String,
    source: Schema.String,
    externalRef: Schema.String,
    amount: Schema.Int,
    currency: CurrencySchema,
  }),
});

export type UnknownPaymentQuarantinedEvent = Schema.Schema.Type<
  typeof UnknownPaymentQuarantinedEvent
>;

/**
 * A domain event (docs/07), discriminated on `name`: each variant fixes its own
 * payload, so a builder cannot emit a malformed payload and a consumer narrows on
 * `name`. `externalUserId` is carried verbatim from the calling system (AC9) and is
 * null only for a quarantined unknown payment.
 */
/**
 * A service action remapped a user's opaque external id (docs/31). Emitted ONLY when
 * the rename opts in (`refireEvents`), so a sink can react to the change; the default
 * rename is silent. `externalUserId` is the NEW id (the go-forward contact); the payload
 * carries the old id and the moved-record counts. Payment events are NOT re-emitted.
 */
export const ExternalUserIdChangedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('external_user_id_changed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    movedPayments: Schema.Int,
    movedSessions: Schema.Int,
  }),
});

export type ExternalUserIdChangedEvent = Schema.Schema.Type<
  typeof ExternalUserIdChangedEvent
>;

export const DomainEvent = Schema.Union(
  InitialPaymentSucceededEvent,
  RecurringPaymentSucceededEvent,
  OneTimePurchaseSucceededEvent,
  InitialPaymentFailedEvent,
  RecurringPaymentFailedEvent,
  PaymentCreatedEvent,
  ChargeRetryFailedEvent,
  ChargeDeferredEvent,
  RenewalFailedEvent,
  PaymentManualRequiredEvent,
  UpcomingChargeEvent,
  PaymentCancelledEvent,
  PaymentReactivatedEvent,
  PaymentDeferredEvent,
  MethodChangedEvent,
  ExternalUserIdChangedEvent,
  CardChangeSucceededEvent,
  CardChangeFailedEvent,
  PaymentRefundedEvent,
  UnknownPaymentQuarantinedEvent,
);

export type DomainEvent = Schema.Schema.Type<typeof DomainEvent>;

/**
 * An event read back from storage for delivery (the sink boundary): the envelope
 * with its payload as opaque JSON. `DomainEvent` is the construction-time type that
 * enforces each payload; after a jsonb round-trip the sink only forwards the stored
 * payload, so it is not re-narrowed on `name`.
 */
export interface StoredEvent {
  readonly id: string;
  /** Never null here: the column is backfilled from `id` and readers coalesce to it. */
  readonly idempotencyKey: string;
  readonly name: EventName;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly externalUserId: string | null;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}
