import { describe, expect, it } from 'vitest';
import { LSP_SERVER_NAME } from '@shared/engine/lsp-tools';
import { buildSystemMcpServers } from './system-mcp-registry';

const byName = () =>
  Object.fromEntries(buildSystemMcpServers().map((s) => [s.name, s]));

describe('buildSystemMcpServers', () => {
  it('LSP is always active (no key needed)', () => {
    const s = byName();
    expect(s[LSP_SERVER_NAME].active).toBe(true);
    expect(s[LSP_SERVER_NAME].inactiveReason).toBeUndefined();
  });

  it('exposes real server names + non-empty tool lists', () => {
    const all = buildSystemMcpServers();
    expect(all.map((s) => s.name)).toEqual([LSP_SERVER_NAME]);
    for (const s of all) expect(s.tools.length).toBeGreaterThan(0);
  });
});
