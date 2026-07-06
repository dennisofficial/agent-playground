import { describe, expect, it } from 'vitest';
import { COCOINDEX_SERVER_NAME, GRAPHIFY_SERVER_NAME } from '../engine/code-index-tools';
import { CONTEXT7_SERVER_NAME } from '../engine/context7-tools';
import { LSP_SERVER_NAME } from '../engine/lsp-tools';
import { buildSystemMcpServers } from './system-mcp-registry';

const byName = (signals: Parameters<typeof buildSystemMcpServers>[0]) =>
  Object.fromEntries(buildSystemMcpServers(signals).map((s) => [s.name, s]));

describe('buildSystemMcpServers', () => {
  it('LSP and graphify are always active (no key needed)', () => {
    const s = byName({ context7Configured: false, openaiKeyConfigured: false });
    expect(s[LSP_SERVER_NAME].active).toBe(true);
    expect(s[GRAPHIFY_SERVER_NAME].active).toBe(true);
    expect(s[LSP_SERVER_NAME].inactiveReason).toBeUndefined();
  });

  it('cocoindex tracks the org OpenAI key', () => {
    expect(byName({ context7Configured: false, openaiKeyConfigured: true })[COCOINDEX_SERVER_NAME].active).toBe(true);
    const off = byName({ context7Configured: false, openaiKeyConfigured: false })[COCOINDEX_SERVER_NAME];
    expect(off.active).toBe(false);
    expect(off.inactiveReason).toMatch(/OpenAI/i);
  });

  it('context7 tracks the deployment key', () => {
    expect(byName({ context7Configured: true, openaiKeyConfigured: false })[CONTEXT7_SERVER_NAME].active).toBe(true);
    const off = byName({ context7Configured: false, openaiKeyConfigured: false })[CONTEXT7_SERVER_NAME];
    expect(off.active).toBe(false);
    expect(off.inactiveReason).toMatch(/CONTEXT7_API_KEY/);
  });

  it('exposes real server names + non-empty tool lists', () => {
    const all = buildSystemMcpServers({ context7Configured: true, openaiKeyConfigured: true });
    expect(all.map((s) => s.name).sort()).toEqual(
      [LSP_SERVER_NAME, GRAPHIFY_SERVER_NAME, COCOINDEX_SERVER_NAME, CONTEXT7_SERVER_NAME].sort(),
    );
    for (const s of all) expect(s.tools.length).toBeGreaterThan(0);
  });
});
