/**
 * Normalize TypeORM `manager.query()` results. The pg driver returns plain `rows[]` for SELECT and
 * INSERT…RETURNING, but a `[rows, affectedCount]` tuple for UPDATE/DELETE…RETURNING — so a naive
 * `result.length`/`result[0]` is wrong for updates. This collapses both to the rows array.
 */
export function rawRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return (Array.isArray(result) ? result : []) as T[];
}

/** Postgres timestamptz comes back as a Date (or string); normalize to an ISO string. */
export const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
