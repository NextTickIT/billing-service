// Renders a stored billing period (`P1M`, `P30D`, `P1Y`) the way a payer reads it —
// "1 місяць", "30 days" — in the viewer's language. Unit plurals come from Intl/CLDR
// because uk/ru need three forms ("1 місяць" / "2 місяці" / "5 місяців") and a
// hand-written rule table is how a payment page starts lying about what it charges.
// Display only: the canonical duration arithmetic stays in the backend's `addPeriod`,
// so a rendering gap here can never move a billing date.
const DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;

// Capture-group order in DURATION — the index carries the unit, so the two must match.
const UNITS = ['year', 'month', 'week', 'day'] as const;

function formatUnit(
  count: number,
  unit: (typeof UNITS)[number],
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(count);
}

/**
 * A multi-component duration renders every non-zero part ("1 month 15 days"). An
 * unparseable or all-zero duration falls back to the raw string: showing `P0D` is a
 * visible bug, while showing nothing would silently hide the cadence from the payer.
 */
export function formatPeriod(period: string, locale: string): string {
  const match = DURATION.exec(period);
  if (match === null) return period;
  const parts = UNITS.flatMap((unit, i) => {
    const count = Number(match[i + 1] ?? 0);
    return count === 0 ? [] : [formatUnit(count, unit, locale)];
  });
  return parts.length === 0 ? period : parts.join(' ');
}
