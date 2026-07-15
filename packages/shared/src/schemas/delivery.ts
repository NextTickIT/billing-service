import { Schema } from 'effect';

/** Durable per-sink delivery outcome (operator-facing). */
export const DeliveryStatus = Schema.Literal('pending', 'delivered', 'failed');

export type DeliveryStatus = Schema.Schema.Type<typeof DeliveryStatus>;

/**
 * An outbox delivery of a domain event to one sink — one row per (event, sink).
 * `status` is the durable outcome; `attemptCount` grows on each retry. (No operator
 * read route in the MVP — deliveries are outbox-driven; a deliveries screen + route
 * are re-added when scoped.)
 */
export const EventDeliveryRow = Schema.Struct({
  id: Schema.String,
  eventId: Schema.String,
  sink: Schema.String,
  status: DeliveryStatus,
  attemptCount: Schema.Int,
  deliveredAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
});

export type EventDeliveryRow = Schema.Schema.Type<typeof EventDeliveryRow>;
