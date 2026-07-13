/**
 * Outgoing domain events must reach each connected sink within this many seconds
 * (delivery SLA). Owned by the event slice; see docs/07-events.md.
 */
export const SINK_DELIVERY_SLA_SECONDS = 60;
