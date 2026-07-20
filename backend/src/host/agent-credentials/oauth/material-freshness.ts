import { EAgentProvider } from '@workspace/shared';

export function parseClaudeExpiresAt(material: string): number | null {
  try {
    const t = (JSON.parse(material) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth
      ?.expiresAt;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function parseCodexLastRefresh(material: string): number | null {
  try {
    const raw = (JSON.parse(material) as { last_refresh?: unknown }).last_refresh;
    if (typeof raw !== 'string') return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * Is `next` a newer credential than `current`? Used to avoid clobbering a fresher token when the engine
 * hands one back concurrently. Falls back to a plain inequality when timestamps can't be parsed.
 */
export function isNewerMaterial(provider: EAgentProvider, next: string, current: string): boolean {
  const parse = provider === EAgentProvider.CLAUDE ? parseClaudeExpiresAt : parseCodexLastRefresh;
  const nw = parse(next);
  const cur = parse(current);
  if (nw !== null && cur !== null) return nw > cur;
  return next !== current;
}
