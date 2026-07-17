export function parseClaudeExpiresAt(secret: string): number | null {
  try {
    const obj = JSON.parse(secret) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const t = obj.claudeAiOauth?.expiresAt;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function isNewerClaudeCredential(next: string, current: string): boolean {
  const nw = parseClaudeExpiresAt(next);
  const cur = parseClaudeExpiresAt(current);
  if (nw !== null && cur !== null) return nw > cur;
  return next !== current;
}
