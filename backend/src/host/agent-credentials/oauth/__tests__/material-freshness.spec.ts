import { EAgentProvider } from '@workspace/shared';
import {
  isNewerMaterial,
  parseClaudeExpiresAt,
  parseCodexLastRefresh,
} from '../material-freshness.util';

const claude = (expiresAt: number): string => JSON.stringify({ claudeAiOauth: { expiresAt } });
const codex = (lastRefresh: string): string => JSON.stringify({ last_refresh: lastRefresh });

describe('parse helpers', () => {
  it('reads claude expiresAt and codex last_refresh', () => {
    expect(parseClaudeExpiresAt(claude(123))).toBe(123);
    expect(parseCodexLastRefresh(codex('2026-07-01T00:00:00.000Z'))).toBe(
      Date.parse('2026-07-01T00:00:00.000Z'),
    );
  });
  it('returns null for unparseable material', () => {
    expect(parseClaudeExpiresAt('not json')).toBeNull();
    expect(parseCodexLastRefresh('{}')).toBeNull();
  });
});

describe('isNewerMaterial', () => {
  it('claude: compares expiresAt', () => {
    expect(isNewerMaterial(EAgentProvider.CLAUDE, claude(200), claude(100))).toBe(true);
    expect(isNewerMaterial(EAgentProvider.CLAUDE, claude(100), claude(200))).toBe(false);
  });
  it('codex: compares last_refresh', () => {
    const older = codex('2026-07-01T00:00:00.000Z');
    const newer = codex('2026-07-02T00:00:00.000Z');
    expect(isNewerMaterial(EAgentProvider.CODEX, newer, older)).toBe(true);
    expect(isNewerMaterial(EAgentProvider.CODEX, older, newer)).toBe(false);
  });
  it('falls back to inequality when timestamps are missing', () => {
    expect(isNewerMaterial(EAgentProvider.CLAUDE, 'a', 'b')).toBe(true);
    expect(isNewerMaterial(EAgentProvider.CLAUDE, 'a', 'a')).toBe(false);
  });
});
