/**
 * Normalize the Claude Agent SDK's `Query.getContextUsage()` raw response into our own trimmed
 * {@link ContextBreakdown} shape. The raw SDK response carries several bulky fields we deliberately drop
 * before this ever reaches persistence — `gridRows` (a full render-grid), `apiUsage`, `deferredBuiltinTools`,
 * `systemPromptSections`, `slashCommands`, `skills`, etc. — which would otherwise bloat the durable
 * `turn_meta` JSON to tens of KB per turn. This keeps a persisted breakdown a few KB: just the category
 * totals plus a capped top-N of the three per-item lists (mcpTools/memoryFiles/agents).
 */
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextBreakdown, ContextBreakdownCategory } from '@workspace/agent-engine';

/** Cap on each of `mcpTools`/`memoryFiles`/`agents` — enough to be useful, small enough to stay compact. */
const MAX_TRIMMED_ITEMS = 20;

/** Drop zero-token entries, sort descending by tokens, and cap to the top {@link MAX_TRIMMED_ITEMS}. */
function trimByTokens<T extends { tokens: number }>(items: T[]): T[] {
  return items
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_TRIMMED_ITEMS);
}

export function normalizeContextBreakdown(
  raw: SDKControlGetContextUsageResponse,
): ContextBreakdown {
  const categories: ContextBreakdownCategory[] = raw.categories.map((c) => ({
    name: c.name,
    tokens: c.tokens,
    color: c.color,
  }));

  const mcpTools = trimByTokens(raw.mcpTools ?? []).map((t) => ({
    name: t.name,
    serverName: t.serverName,
    tokens: t.tokens,
  }));
  const memoryFiles = trimByTokens(raw.memoryFiles ?? []).map((f) => ({
    path: f.path,
    tokens: f.tokens,
  }));
  const agents = trimByTokens(raw.agents ?? []).map((a) => ({
    agentType: a.agentType,
    tokens: a.tokens,
  }));

  return {
    model: raw.model,
    totalTokens: raw.totalTokens,
    maxTokens: raw.maxTokens,
    percentage: raw.percentage,
    categories,
    ...(mcpTools.length > 0 ? { mcpTools } : {}),
    ...(memoryFiles.length > 0 ? { memoryFiles } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
}
