import { formatPeriod, isRenderablePeriod } from '@billing-service/shared';

/**
 * Human-readable twins of payload fields, added ONLY on the way into SendPulse.
 *
 * The stored event stays canonical — ISO-8601 instants and ISO-8601 durations — because
 * that is what every other consumer (the operator console, the quarantine flow, any
 * future sink) reads, and because a rendered string cannot be computed back into a date.
 * SendPulse is the one place that needs prose: its flows drop these straight into a
 * message to a customer, and neither `2026-10-02T21:30:00.000Z` nor `P1M` is something
 * you can put in front of a person.
 */

/** The audience is Ukrainian; a notice naming the wrong day is worse than none. */
const TIME_ZONE = 'Europe/Kyiv';

/** Fixed for now — the SendPulse flows are Russian-language. */
const LOCALE = 'ru';

/**
 * Payload keys carrying an ISO-8601 instant, listed rather than sniffed.
 *
 * A "looks like a date" heuristic eventually formats something that is not one, and the
 * convention alone cannot be trusted to find them: `newPeriodEnd` carries a date while
 * ending in neither `Date` nor `At`. `formatted.test.ts` walks the event union and fails
 * when an event gains a date field that is missing here, so a new event cannot ship
 * without its formatted twin.
 */
export const DATE_FIELDS: ReadonlySet<string> = new Set([
  'nextPaymentDate',
  'nextRetryDate',
  'dueDate',
  'windowExpiresAt',
  'newPeriodEnd',
  'chargeDate',
  // The window a successful charge bought. A flow saying "paid through 01.04.2026" needs
  // the rendered end, not `2026-04-01T00:00:00.000Z`.
  'periodStart',
  'periodEnd',
]);

/** Payload keys carrying an ISO-8601 duration. */
export const PERIOD_FIELDS: ReadonlySet<string> = new Set(['period']);

/**
 * DD.MM.YYYY in Kyiv. Built once: constructing an Intl formatter is expensive enough
 * that doing it per field per delivery would show up under load.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const formatDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : DATE_FORMAT.format(at);
};

/**
 * The `*_formatted` fields for a payload. Returns only what it could render: a null
 * `nextPaymentDate` (a one-time purchase never renews) and a `P0D` period (the one-time
 * sentinel) produce no key at all, so a flow referencing one gets an empty variable
 * rather than the string "null" or "P0D" in a customer's message.
 */
export const formattedFields = (
  payload: Readonly<Record<string, unknown>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (DATE_FIELDS.has(key)) {
      const rendered = formatDate(value);
      if (rendered !== null) out[`${key}_formatted`] = rendered;
      continue;
    }
    if (
      PERIOD_FIELDS.has(key) &&
      typeof value === 'string' &&
      isRenderablePeriod(value)
    ) {
      out[`${key}_formatted`] = formatPeriod(value, LOCALE);
    }
  }
  return out;
};
