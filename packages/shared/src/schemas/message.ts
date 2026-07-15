import { Schema } from 'effect';

/**
 * Internal queue message types (docs/09) — the vocabulary of work the worker
 * dispatches. Defined once here so every producer and the worker reference one
 * source of truth instead of hardcoding the strings per module.
 */
export const PAYMENT_EVENT_RECEIVED = 'payment_event_received';
export const PAYMENT_REBIND = 'payment_rebind';
export const DELIVER_EVENT = 'deliver_event';
export const PAYMENT_CANCEL = 'payment_cancel';

export const MESSAGE_TYPES = [
  PAYMENT_EVENT_RECEIVED,
  PAYMENT_REBIND,
  DELIVER_EVENT,
  PAYMENT_CANCEL,
] as const;

export const MessageType = Schema.Literal(...MESSAGE_TYPES);

export type MessageType = Schema.Schema.Type<typeof MessageType>;
