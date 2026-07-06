/**
 * The monotonic freshness rule for a Codex `auth.json` blob — the ONE place that decides whether one
 * Codex credential supersedes another. Shared by `TenantCredentialStore.advanceCodexAuthSecret` (the
 * turn-completion write-back) AND the dev credential seed, so both agree on "the fresher token wins" and
 * a re-seed can never regress a token the running app already refreshed. Dependency-free on purpose: the
 * seed imports it without pulling in the Nest/TypeORM store module.
 */

/** The Codex `auth.json` top-level `last_refresh` as an epoch (ms), or null when absent/unparseable. */
export function parseCodexLastRefresh(secret: string): number | null {
  try {
    const obj = JSON.parse(secret) as { last_refresh?: unknown };
    if (typeof obj.last_refresh !== 'string') return null;
    const t = Date.parse(obj.last_refresh);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * Whether `next` is a strictly newer Codex credential than `current`. Prefer the monotonic `last_refresh`
 * timestamp (both must parse); when either is missing, fall back to "changed at all" so we still persist a
 * genuine refresh but never rewrite an identical blob.
 */
export function isNewerCodexAuth(next: string, current: string): boolean {
  const nw = parseCodexLastRefresh(next);
  const cur = parseCodexLastRefresh(current);
  if (nw !== null && cur !== null) return nw > cur;
  return next !== current;
}
