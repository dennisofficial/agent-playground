/** Clamp a selection into a list that changed size underneath it. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/**
 * Case-insensitive substring match across every field a row is findable by. An empty query matches
 * everything, so "filtering is off" is the same code path as "filtering is on and matches" — there
 * is no mode flag to keep in sync with the query.
 */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle));
}
