import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { normalizeContextBreakdown } from './context-breakdown';

function makeRaw(
  overrides: Partial<SDKControlGetContextUsageResponse> = {},
): SDKControlGetContextUsageResponse {
  return {
    categories: [
      { name: 'System prompt', tokens: 261, color: 'promptBorder' },
      { name: 'System tools', tokens: 17407, color: 'inactive' },
      {
        name: 'System tools (deferred)',
        tokens: 15310,
        color: 'inactive',
        isDeferred: true,
      },
      { name: 'Memory files', tokens: 5897, color: 'claude' },
      { name: 'Free space', tokens: 904383, color: 'promptBorder' },
    ],
    totalTokens: 29617,
    maxTokens: 967000,
    rawMaxTokens: 967000,
    percentage: 3,
    gridRows: [],
    model: 'claude-opus-4-...',
    memoryFiles: [{ path: '/some/CLAUDE.md', type: 'project', tokens: 5897 }],
    mcpTools: [{ name: 'some_tool', serverName: 'some-server', tokens: 120, isLoaded: true }],
    agents: [{ agentType: 'general-purpose', source: 'builtin', tokens: 0 }],
    isAutoCompactEnabled: true,
    ...overrides,
  } as SDKControlGetContextUsageResponse;
}

describe('normalizeContextBreakdown', () => {
  it('maps model/totalTokens/maxTokens/percentage/categories verbatim, dropping isDeferred', () => {
    const out = normalizeContextBreakdown(makeRaw());
    expect(out.model).toBe('claude-opus-4-...');
    expect(out.totalTokens).toBe(29617);
    expect(out.maxTokens).toBe(967000);
    expect(out.percentage).toBe(3);
    expect(out.categories).toEqual([
      { name: 'System prompt', tokens: 261, color: 'promptBorder' },
      { name: 'System tools', tokens: 17407, color: 'inactive' },
      { name: 'System tools (deferred)', tokens: 15310, color: 'inactive' },
      { name: 'Memory files', tokens: 5897, color: 'claude' },
      { name: 'Free space', tokens: 904383, color: 'promptBorder' },
    ]);
    for (const cat of out.categories) expect(cat).not.toHaveProperty('isDeferred');
  });

  it('drops zero-token entries from mcpTools/memoryFiles/agents', () => {
    const out = normalizeContextBreakdown(makeRaw());
    expect(out.agents).toBeUndefined();
    expect(out.mcpTools).toEqual([{ name: 'some_tool', serverName: 'some-server', tokens: 120 }]);
    expect(out.memoryFiles).toEqual([{ path: '/some/CLAUDE.md', tokens: 5897 }]);
  });

  it('caps mcpTools/memoryFiles/agents to the top 20 by tokens', () => {
    const mcpTools = Array.from({ length: 25 }, (_, i) => ({
      name: `tool-${i}`,
      serverName: 'srv',
      tokens: i + 1, // 1..25, all nonzero
      isLoaded: true,
    }));
    const out = normalizeContextBreakdown(makeRaw({ mcpTools }));
    expect(out.mcpTools).toHaveLength(20);
    const tokens = out.mcpTools!.map((t) => t.tokens).sort((a, b) => a - b);
    expect(tokens).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 6), // [6, 7, ..., 25]
    );
  });

  it('omits mcpTools/memoryFiles/agents entirely when the filtered list is empty', () => {
    const out = normalizeContextBreakdown(makeRaw({ mcpTools: [], memoryFiles: [], agents: [] }));
    expect(out.mcpTools).toBeUndefined();
    expect(out.memoryFiles).toBeUndefined();
    expect(out.agents).toBeUndefined();
  });
});
