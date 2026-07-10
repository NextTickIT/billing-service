/**
 * Fixed retry schedule (days from the first failed recurring charge).
 * See docs/02-functional-requirements.md FR-005.
 */
export const RETRY_SCHEDULE_DAYS = [0, 1, 3, 5, 7] as const;

/** Outgoing events must reach each sink within this many seconds (SLA). */
export const SINK_DELIVERY_SLA_SECONDS = 60;
