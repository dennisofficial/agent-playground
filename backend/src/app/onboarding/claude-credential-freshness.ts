/**
 * The monotonic freshness rule for a Claude `claudeAiOauth` blob — the ONE place that decides whether one
 * Claude personal credential supersedes another. Sibling to `codex-auth-freshness.ts`; owned by the storage
 * layer (this thread) so it's importable without pulling in the Nest/TypeORM store module. Thread 2's Claude
 * adapter imports this helper for its own `isNewer` rather than defining a duplicate.
 */

/** The Claude `claudeAiOauth.expiresAt` as an epoch (ms), or null when absent/unparseable. */
export function parseClaudeExpiresAt(secret: string): number | null {
  try {
    const obj = JSON.parse(secret) as { claudeAiOauth?: { expiresAt?: unknown } };
    const t = obj.claudeAiOauth?.expiresAt;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Whether `next` is a strictly newer Claude credential than `current`. Prefer the `expiresAt` timestamp
 * (both must parse); when either is missing, fall back to "changed at all" so we still persist a genuine
 * refresh but never rewrite an identical blob.
 */
export function isNewerClaudeCredential(next: string, current: string): boolean {
  const nw = parseClaudeExpiresAt(next);
  const cur = parseClaudeExpiresAt(current);
  if (nw !== null && cur !== null) return nw > cur;
  return next !== current;
}
