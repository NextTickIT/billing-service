import { Schema } from 'effect';

/**
 * Outgoing domain events must reach each connected sink within this many seconds
 * (delivery SLA). Owned by the event slice; see docs/07-events.md.
 */
export const SINK_DELIVERY_SLA_SECONDS = 60;

/**
 * The minimal, extensible event vocabulary (docs/07 / 00 §6). These names are the
 * EXTERNAL contract carried to every sink, so they are strings (not the numeric
 * enums used for stored-at-rest values). `externalUserId` is present on all of
 * them except `unknown_payment_quarantined`, where the user is by definition
 * unknown.
 */
export const EVENT_NAMES = [
  'payment_succeeded',
  'charge_retry_failed',
  'renewal_failed',
  'subscription_created',
  'subscription_cancelled',
  'unknown_payment_quarantined',
] as const;

export const EventName = Schema.Literal(...EVENT_NAMES);

export type EventName = Schema.Schema.Type<typeof EventName>;

/**
 * The event envelope (docs/07). `payload` is event-specific JSON (amounts inside
 * are integer minimal currency units); `occurredAt` is UTC. `externalUserId` is
 * carried verbatim from the calling system (AC9) and is null only for a
 * quarantined unknown payment.
 */
export const DomainEvent = Schema.Struct({
  id: Schema.String,
  name: EventName,
  occurredAt: Schema.Date,
  correlationId: Schema.String,
  externalUserId: Schema.NullOr(Schema.String),
  aggregateId: Schema.String,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export type DomainEvent = Schema.Schema.Type<typeof DomainEvent>;

/** Publish params: the server owns `id`; the caller supplies everything else. */
export const CreateDomainEvent = DomainEvent.pipe(Schema.omit('id'));

export type CreateDomainEvent = Schema.Schema.Type<typeof CreateDomainEvent>;
