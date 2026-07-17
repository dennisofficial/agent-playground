
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

export function isNewerCodexAuth(next: string, current: string): boolean {
  const nw = parseCodexLastRefresh(next);
  const cur = parseCodexLastRefresh(current);
  if (nw !== null && cur !== null) return nw > cur;
  return next !== current;
}
