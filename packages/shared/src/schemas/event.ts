import { Schema } from 'effect';

import { CurrencySchema } from '@/schemas/payment.js';

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
  'initial_payment_failed',
  'charge_retry_failed',
  'renewal_failed',
  'payment_created',
  'payment_cancelled',
  'payment_reactivated',
  'payment_deferred',
  'card_change_succeeded',
  'card_change_failed',
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
  occurredAt: Schema.Date,
  correlationId: Schema.String,
  aggregateId: Schema.String,
};

/**
 * A successful payment, split by scenario so downstream flows can differ: an
 * INITIAL checkout payment vs a RECURRING renewal charge. Both carry the same
 * facts; the pipeline picks the variant from the match kind ('checkout' vs
 * 'recurring'). A matched incoming event or an operator bind produces one of these.
 */
const succeededPayload = {
  amount: Schema.Int,
  currency: CurrencySchema,
  method: Schema.Int,
  period: Schema.String,
  source: Schema.String,
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
  payload: Schema.Struct({
    amount: Schema.Int,
    currency: CurrencySchema,
    method: Schema.Int,
    period: Schema.String,
    reason: Schema.String,
    source: Schema.String,
  }),
});

export type InitialPaymentFailedEvent = Schema.Schema.Type<
  typeof InitialPaymentFailedEvent
>;

/** A brand-new gateway payment created from a first checkout payment. */
export const PaymentCreatedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('payment_created'),
  externalUserId: Schema.String,
  payload: Schema.Struct({
    amount: Schema.Int,
    currency: CurrencySchema,
    period: Schema.String,
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

/** The retry schedule is exhausted; the subscription stops renewing (FR-005). */
export const RenewalFailedEvent = Schema.Struct({
  ...envelope,
  name: Schema.Literal('renewal_failed'),
  externalUserId: Schema.String,
  payload: Schema.Struct({ reason: Schema.String }),
});

export type RenewalFailedEvent = Schema.Schema.Type<typeof RenewalFailedEvent>;

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
export const DomainEvent = Schema.Union(
  InitialPaymentSucceededEvent,
  RecurringPaymentSucceededEvent,
  InitialPaymentFailedEvent,
  PaymentCreatedEvent,
  ChargeRetryFailedEvent,
  RenewalFailedEvent,
  PaymentCancelledEvent,
  PaymentReactivatedEvent,
  PaymentDeferredEvent,
  CardChangeSucceededEvent,
  CardChangeFailedEvent,
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
  readonly name: EventName;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly externalUserId: string | null;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}
