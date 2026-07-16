/**
 * The closed thread-type vocabulary — the deterministic routing key for review-lens selection.
 *
 * `type` crosses three boundaries as a plain string (the DB `text` column, the LLM's free-text plan
 * output parsed in the brain, and skill `reviewFor` frontmatter), so it is modelled as an `as const`
 * union rather than a TS `enum`: a string-literal union needs no casts at those boundaries and the
 * array doubles as the runtime-iterable set `coerceThreadType` validates against. `general` is the
 * total fallback for unmatched / bugfix / direct-build threads.
 */
export const THREAD_TYPES = [
  'backend',
  'frontend',
  'docs',
  'testing',
  'infra',
  'data',
  'general',
] as const;

export type ThreadType = (typeof THREAD_TYPES)[number];

const THREAD_TYPE_SET = new Set<string>(THREAD_TYPES);

/** Coerce any raw value to a valid ThreadType; unknown/empty -> 'general'. */
export function coerceThreadType(raw: unknown): ThreadType {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  return (THREAD_TYPE_SET.has(value) ? value : 'general') as ThreadType;
}
