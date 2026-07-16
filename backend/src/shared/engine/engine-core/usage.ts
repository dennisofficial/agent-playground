import type {
  CodexReasoningEffort,
  EngineUsage,
  ModelUsageBreakdown,
  ReasoningEffort,
} from '../engine.types';

// Claude's Options.effort has no 'minimal'; map it to the nearest ('low'). Others pass through.
export function toClaudeEffort(
  e?: ReasoningEffort,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!e) return undefined;
  return e === 'minimal' ? 'low' : e;
}
// Codex's effort has no 'max'; clamp to its ceiling ('xhigh'). Others pass through.
export function toCodexEffort(
  e?: ReasoningEffort,
): CodexReasoningEffort | undefined {
  if (!e) return undefined;
  return e === 'max' ? 'xhigh' : e;
}

/**
 * Fold one result's {@link EngineUsage} into a running accumulator. A background-task hold yields ≥2
 * results per turn (the immediate first result + the post-settlement auto-continuation), so the BILLING
 * token fields are SUMMED across results, including the per-model breakdown. Occupancy-and-label fields
 * (`contextTokens`/`contextModel`/`model`) reflect the LATEST result (the turn-end window), so `next`
 * overwrites when it carries them. `next` undefined (a result with no usage) leaves `acc` unchanged.
 */
export function addClaudeUsage(
  acc: EngineUsage,
  next: EngineUsage | undefined,
): EngineUsage {
  if (!next) return acc;
  const inputTokens = (acc.inputTokens ?? 0) + (next.inputTokens ?? 0);
  const outputTokens = (acc.outputTokens ?? 0) + (next.outputTokens ?? 0);
  const cacheReadTokens =
    (acc.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  const cacheWriteTokens =
    (acc.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  const reasoningTokens =
    (acc.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  const bothCostAbsent =
    acc.costUsd === undefined && next.costUsd === undefined;
  const costUsd = bothCostAbsent
    ? undefined
    : (acc.costUsd ?? 0) + (next.costUsd ?? 0);
  const modelUsage = addClaudeModelUsage(acc.modelUsage, next.modelUsage);
  return {
    ...acc,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    // Occupancy + labels track the LATEST result.
    ...(next.model ? { model: next.model } : {}),
    ...(next.contextTokens !== undefined
      ? { contextTokens: next.contextTokens }
      : {}),
    ...(next.contextModel ? { contextModel: next.contextModel } : {}),
    ...(modelUsage ? { modelUsage } : {}),
  };
}

function addClaudeModelUsage(
  acc: Record<string, ModelUsageBreakdown> | undefined,
  next: Record<string, ModelUsageBreakdown> | undefined,
): Record<string, ModelUsageBreakdown> | undefined {
  if (!acc && !next) return undefined;
  const out: Record<string, ModelUsageBreakdown> = {};
  for (const [model, usage] of Object.entries(acc ?? {}))
    out[model] = { ...usage };
  for (const [model, usage] of Object.entries(next ?? {})) {
    const prior = out[model];
    const webSearchRequests =
      (prior?.webSearchRequests ?? 0) + (usage.webSearchRequests ?? 0);
    out[model] = {
      inputTokens: (prior?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prior?.outputTokens ?? 0) + usage.outputTokens,
      cacheReadTokens: (prior?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
      cacheWriteTokens: (prior?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
      costUsd: (prior?.costUsd ?? 0) + usage.costUsd,
      ...(webSearchRequests > 0 ? { webSearchRequests } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Extract token usage from a Claude success result. Convention: inputTokens = total INCLUDING cache. */
export function extractClaudeUsage(
  message: Record<string, unknown>,
  model: string | undefined,
): EngineUsage | undefined {
  const u = message.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!u) return undefined;
  const costUsd = message.total_cost_usd as number | undefined;
  // The SDK's per-model breakdown for the WHOLE turn (orchestrator + subagents), keyed by model id.
  // Formerly collapsed to `Object.keys(...)[0]` (dropping every model but the first); now carried in
  // full onto `usage.modelUsage` as the authoritative source for per-model token/cost analytics.
  const rawModelUsage = message.modelUsage as
    | Record<
        string,
        {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD?: number;
          webSearchRequests?: number;
        }
      >
    | undefined;
  const modelUsage: Record<string, ModelUsageBreakdown> | undefined =
    rawModelUsage
      ? Object.fromEntries(
          Object.entries(rawModelUsage).map(([m, mu]) => [
            m,
            {
              inputTokens: mu.inputTokens ?? 0,
              outputTokens: mu.outputTokens ?? 0,
              cacheReadTokens: mu.cacheReadInputTokens ?? 0,
              cacheWriteTokens: mu.cacheCreationInputTokens ?? 0,
              costUsd: mu.costUSD ?? 0,
              ...(mu.webSearchRequests
                ? { webSearchRequests: mu.webSearchRequests }
                : {}),
            },
          ]),
        )
      : undefined;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
  // The turn's PRIMARY (orchestrator) model. Prefer the model we invoked the SDK with — it's the main
  // agent's model by construction, guaranteed present. NOT `Object.keys(modelUsage)[0]`: modelUsage is the
  // whole-turn billing rollup (orchestrator + subagents + SDK-internal helper calls) and object-key order
  // isn't guaranteed, so a subagent/internal model (e.g. a Haiku housekeeping call) could sort first and
  // mislabel the turn. modelUsage stays the authoritative per-model breakdown below; this is only the label.
  const usedModel =
    model ?? (modelUsage ? Object.keys(modelUsage)[0] : undefined);
  return {
    inputTokens,
    ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(usedModel ? { model: usedModel } : {}),
    ...(modelUsage ? { modelUsage } : {}),
  };
}
