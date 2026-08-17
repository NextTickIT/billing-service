// Backend timestamps are rendered in the viewer's chosen language so dates read
// natively (uk/ru → 16.07.2026, not the en-US 7/16/2026 the runtime default gives).
type DateInput = string | Date;

export function formatDate(value: DateInput, locale: string): string {
  return new Date(value).toLocaleDateString(locale);
}

export function formatDateTime(value: DateInput, locale: string): string {
  return new Date(value).toLocaleString(locale);
}
