import { Injectable } from '@nestjs/common';
import { EAgentProvider } from '@workspace/shared';

/** Decides whether a rotated secret is newer than the stored one, so a stale write can't clobber it. */
@Injectable()
export class MaterialFreshnessService {
  parseClaudeExpiresAt(material: string): number | null {
    try {
      const t = (JSON.parse(material) as { claudeAiOauth?: { expiresAt?: unknown } }).claudeAiOauth
        ?.expiresAt;
      return typeof t === 'number' && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  parseCodexLastRefresh(material: string): number | null {
    try {
      const raw = (JSON.parse(material) as { last_refresh?: unknown }).last_refresh;
      if (typeof raw !== 'string') return null;
      const t = Date.parse(raw);
      return Number.isNaN(t) ? null : t;
    } catch {
      return null;
    }
  }

  isNewerMaterial(provider: EAgentProvider, next: string, current: string): boolean {
    const parse =
      provider === EAgentProvider.CLAUDE
        ? (m: string) => this.parseClaudeExpiresAt(m)
        : (m: string) => this.parseCodexLastRefresh(m);
    const nw = parse(next);
    const cur = parse(current);
    if (nw !== null && cur !== null) return nw > cur;
    return next !== current;
  }
}
