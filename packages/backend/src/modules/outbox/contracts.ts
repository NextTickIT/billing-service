import { Schema } from 'effect';

/**
 * Outbox contracts. Delivery scheduling rides the durable queue: publishing an
 * event enqueues one `deliver_event` message per (event, sink), keyed on the
 * delivery id so a replay dedupes. `event_deliveries.status` is the durable per-sink
 * outcome the operator watches. The public shapes (`DeliveryStatus`,
 * `EventDeliveryRow`) and the message type (`DELIVER_EVENT`) live in shared.
 */
export {
  DeliveryStatus,
  EventDeliveryRow,
  DELIVER_EVENT,
} from '@billing-service/shared';

/** Payload of a `deliver_event` message: which delivery to attempt. */
export const DeliverEventPayload = Schema.Struct({
  deliveryId: Schema.String,
});

export type DeliverEventPayload = Schema.Schema.Type<
  typeof DeliverEventPayload
>;
