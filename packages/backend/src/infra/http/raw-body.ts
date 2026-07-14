/**
 * Providers post their callbacks with assorted content-types (WayForPay uses
 * form-encoded, not JSON), which Fastify's JSON-only parser rejects with 415. Parse
 * any non-JSON body as a raw string → JSON, falling back to the form-encoded
 * "the whole JSON is the first key" shape WayForPay sends (docs/14). An unparseable
 * body yields `{}` so the route decodes it and fails validation, never a 415/500.
 */
export const parseRawBody = (raw: string): unknown => {
  const tryJson = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryJson(raw);
  if (direct !== undefined) {
    return direct;
  }
  const firstKey = raw.split('&')[0]?.split('=')[0] ?? '';
  return tryJson(decodeURIComponent(firstKey)) ?? {};
};
