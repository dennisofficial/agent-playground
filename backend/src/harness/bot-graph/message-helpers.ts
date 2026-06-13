import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChannelMsg } from '../channel/channel.types';
import type { MessageUsage } from '../domain/conductor-events';
import { flattenContent } from '../domain/text';
import { extractMessageUsage } from '../llm/usage-format';

/** Channel message → a `Speaker: text` HumanMessage (how a bot reads what others said). */
export const asInput = (m: ChannelMsg): HumanMessage =>
  new HumanMessage(`${m.author}: ${m.text}`);

/** Token usage off a model reply (delegates to the shared extractor — the same one the conductor's
 * `commit` uses — so cache-write TTL buckets are split consistently). */
export const usageOf = (m: AIMessage): MessageUsage | undefined =>
  extractMessageUsage(m);

/**
 * A shallow copy of `m` with a cache breakpoint on its last non-thinking content block — WITHOUT
 * mutating the original (it rides in checkpointed state, so a mutation would poison the durable
 * history). Only anchors on human/ai turns carrying cacheable text; other turns fall back to
 * system-only caching. `thinking` and `redacted_thinking` blocks are intentionally skipped when
 * searching for the anchor: Anthropic rejects `cache_control` on thinking blocks, and a
 * thinking-only assistant turn (no trailing text block) returns `m` unchanged so that turn falls
 * back to system-only caching rather than crashing the API call.
 */
export const withCacheBreakpoint = (m: BaseMessage): BaseMessage => {
  const kind = m.getType();
  if (kind !== 'human' && kind !== 'ai') return m;
  const cc = { type: 'ephemeral', ttl: '1h' } as const;
  const clone = (content: unknown): BaseMessage => {
    const Ctor = m.constructor as unknown as new (
      fields: unknown,
    ) => BaseMessage;
    return new Ctor({ ...m, content });
  };
  if (typeof m.content === 'string') {
    return m.content.trim()
      ? clone([{ type: 'text', text: m.content, cache_control: cc }])
      : m;
  }
  const isThinking = (b: unknown): boolean =>
    typeof b === 'object' &&
    b !== null &&
    ((b as { type?: string }).type === 'thinking' ||
      (b as { type?: string }).type === 'redacted_thinking');
  let anchor = -1;
  for (let i = m.content.length - 1; i >= 0; i--) {
    if (!isThinking(m.content[i])) {
      anchor = i;
      break;
    }
  }
  return anchor >= 0
    ? clone(
        m.content.map((b, i) =>
          i === anchor ? { ...b, cache_control: cc } : b,
        ),
      )
    : m;
};

/**
 * READ-TIME transform: replace ToolMessages from prior turns with compact evidence records.
 *
 * "Prior turn" = a ToolMessage whose `tool_call_id` belongs to an AI message that is NOT the
 * last AI message in the array. The last AI message's tool results (the current-turn context
 * the model actively needs) stay full. Older results are often bulky raw outputs whose exact
 * contents matter less than knowing the call was made; the short evidence record keeps the
 * model honest without blowing up the context window ("Lost in the Middle" effect).
 *
 * Format per compacted message:
 *   `[Tool: <name>] Args: <first 100 chars of JSON args>… Result: <first 200 chars>… (full result in transcript)`
 *
 * The `tool_call_id` is preserved on the compacted ToolMessage so the reference stays
 * traceable (Anthropic's pairing requirement is still satisfied — the id matches the AI
 * message's tool_call entry even though the result is shortened).
 *
 * Like `repairDanglingToolCalls`, this is READ-TIME ONLY — the checkpoint (`state.messages`) is
 * never mutated. Lazily allocates a new array only when at least one compaction is needed.
 */
export const compactPriorToolResults = (
  history: BaseMessage[],
): BaseMessage[] => {
  // Find the last AI message — its tool_call_ids are current-turn results (keep full).
  let lastAiIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].getType() === 'ai') {
      lastAiIdx = i;
      break;
    }
  }
  const currentIds = new Set<string>();
  if (lastAiIdx >= 0) {
    for (const c of (history[lastAiIdx] as AIMessage).tool_calls ?? []) {
      if (c.id) currentIds.add(c.id);
    }
  }

  // Index args by tool_call_id for snippet rendering (args live on the AI message, not the
  // ToolMessage — scan all AI messages so we can surface args even for prior turns).
  const argsByCallId = new Map<string, unknown>();
  for (const m of history) {
    if (m.getType() !== 'ai') continue;
    for (const c of (m as AIMessage).tool_calls ?? []) {
      if (c.id) argsByCallId.set(c.id, c.args);
    }
  }

  let out: BaseMessage[] | undefined;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.getType() !== 'tool') continue;
    const tm = m as ToolMessage;
    if (currentIds.has(tm.tool_call_id)) continue; // current-turn result — keep full

    // Prior-turn result — replace with a compact evidence record.
    out ??= [...history];
    const name = tm.name ?? 'unknown';
    const args = argsByCallId.get(tm.tool_call_id);
    const argsRaw = args !== undefined ? JSON.stringify(args) : '';
    const argsSnip =
      argsRaw.length > 100 ? `${argsRaw.slice(0, 100)}…` : argsRaw;
    const resultRaw = flattenContent(tm.content);
    const resultSnip =
      resultRaw.length > 200 ? `${resultRaw.slice(0, 200)}…` : resultRaw;
    out[i] = new ToolMessage({
      tool_call_id: tm.tool_call_id,
      name: tm.name,
      content: `[Tool: ${name}] Args: ${argsSnip} Result: ${resultSnip} (full result in transcript)`,
    });
  }
  return out ?? history;
};

/**
 * SELF-HEALING GUARD: repair dangling tool calls in the durable history before every model call.
 *
 * LangGraph checkpoints after EVERY node, so an interruption between the `llm` superstep (which
 * commits an AI message WITH tool_calls) and the `tools` superstep (which commits the results) —
 * a crash, a process exit mid-turn, an aborted stream — leaves an AIMessage whose `tool_use` has
 * no `tool_result` after it. Anthropic rejects that history outright (400 INVALID_TOOL_RESULTS),
 * which would otherwise brick the thread PERMANENTLY: every retry replays the same poisoned
 * checkpoint, and the conductor's retry-cap only skips channel messages, not history.
 *
 * The repair is READ-TIME and ephemeral (like the recalled-memory block): synthetic tool_results
 * are spliced in right after any dangling tool_use for THIS call's input, never persisted — so the
 * checkpoint stays an honest record of what happened, and every future read heals the same way.
 */
export const repairDanglingToolCalls = (
  history: BaseMessage[],
): BaseMessage[] => {
  let repaired: BaseMessage[] | undefined;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.getType() !== 'ai') continue;
    const calls = (m as AIMessage).tool_calls ?? [];
    if (calls.length === 0) continue;
    // Collect the tool_result ids in the contiguous tool-message block following this AI message.
    const answered = new Set<string>();
    let j = i + 1;
    while (j < history.length && history[j].getType() === 'tool') {
      const id = (history[j] as ToolMessage).tool_call_id;
      if (id) answered.add(id);
      j++;
    }
    const missing = calls.filter((c) => c.id && !answered.has(c.id));
    if (missing.length === 0) continue;
    repaired ??= [...history];
    // Splice synthetic results in right after the existing tool block (offset by prior splices).
    const insertAt = j + (repaired.length - history.length);
    repaired.splice(
      insertAt,
      0,
      ...missing.map(
        (c) =>
          new ToolMessage({
            tool_call_id: c.id as string,
            name: c.name,
            content:
              '(no result recorded — the turn was interrupted before this tool finished)',
          }),
      ),
    );
  }
  return repaired ?? history;
};
