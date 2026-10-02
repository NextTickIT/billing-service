/**
 * camelCase → snake_case on the way into the CRM, and nowhere else.
 *
 * The stored event keeps the camelCase vocabulary every other consumer already reads
 * (the operator console, the SendPulse sink, the quarantine flow). The CRM asked for
 * snake_case as its one dialect, so the rename happens at ITS delivery boundary — the
 * same seam `formatted.ts` uses — rather than by renaming the event contract and forcing
 * every existing consumer to move at once.
 *
 * `metadata` is EXEMPT, values and all. It is the caller's own object, echoed unchanged by
 * promise; rewriting keys inside it would corrupt data we explicitly do not own and cannot
 * reconstruct. A caller who sends `{"utmSource": "x"}` must read back `utmSource`.
 */

/** Keys whose VALUE is passed through verbatim — no recursion, no renaming inside. */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(['metadata']);

/**
 * `externalUserId` → `external_user_id`, `periodStart` → `period_start`.
 *
 * Also splits a digit run into its own group (`dueDate2` → `due_date_2`) and collapses a
 * run of capitals (`orderURL` → `order_url`), so an acronym does not become `o_r_d_e_r`.
 * A key that is already snake_case, or has no boundary at all, is returned unchanged.
 */
export const toSnakeCase = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1_$2')
    .toLowerCase();

/**
 * Deep-rename every key, through nested objects and arrays, except inside an opaque key.
 *
 * Dates are left as-is for the caller to serialize (`JSON.stringify` renders them ISO);
 * cloning them here would be a second place that decides the wire format for an instant.
 */
export const snakeCaseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(snakeCaseKeys);
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[toSnakeCase(key)] = OPAQUE_KEYS.has(key) ? inner : snakeCaseKeys(inner);
  }
  return out;
};
