/**
 * Double-quoted, comma-joined column list derived from a struct schema's keys, so
 * a table's column set has one source of truth (the schema) and the SQL cannot
 * silently drift from it. Every name is quoted because our columns are camelCase
 * and Postgres would otherwise fold them to lowercase. Pass `Schema.fields`.
 */
export const columnList = (fields: Record<string, unknown>): string =>
  Object.keys(fields)
    .map((name) => `"${name}"`)
    .join(', ');
