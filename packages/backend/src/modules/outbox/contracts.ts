import { Schema } from 'effect';

/**
 * Outbox contracts. Delivery scheduling rides the durable queue: publishing an
 * event enqueues one `deliver_event` message per (event, sink), keyed on the
 * delivery id so a replay dedupes. `event_deliveries.status` is the durable
 * per-sink outcome the operator watches.
 */

// THis is public API - hence miove to shared
/** Durable per-sink delivery outcome. */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed';

// mut be od proper domain  type
/** Queue message type that drives one delivery attempt. */
export const DELIVER_EVENT = 'deliver_event';

/** Payload of a `deliver_event` message: which delivery to attempt. */
export const DeliverEventPayload = Schema.Struct({
  deliveryId: Schema.String,
});

export type DeliverEventPayload = Schema.Schema.Type<
  typeof DeliverEventPayload
>;

/** A delivery record row (operator-facing via GET /api/support/deliveries). */
export interface EventDeliveryRow {
  readonly id: string;
  readonly eventId: string;
  readonly sink: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
}
