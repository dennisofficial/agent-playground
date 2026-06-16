import type { AIMessage } from '@langchain/core/messages';
import type { RefreshScope } from '../tools/tool.types';
import type { BotStateType } from './bot-state';

/** Out of `llm`: revision loop, tool calls, or done. */
export const afterLlm = (
  state: BotStateType,
): 'tools' | 'llm' | 'reconcile' => {
  // Draft check FIRST: a suppression returns WITHOUT appending its AI message, so `last` would be
  // stale history (in a crash-repaired thread it could even be a dangling tool_call AI — routing
  // that to `tools` would re-execute stale calls). llmNode clears `draft` on every non-suppression
  // return, so this route is reachable only from an actual suppression.
  if (state.draft) return 'llm'; // read-the-room revision pass
  const last = state.messages[state.messages.length - 1] as
    | AIMessage
    | undefined;
  return last?.tool_calls?.length ? 'tools' : 'reconcile';
};

/**
 * Derive the set of context scopes dirtied by the last tool batch. Used both by
 * `makeAfterToolLoopGuard` (to decide whether to insert a `refreshContext` superstep) and by
 * `refreshContextNode` (to know which slices to recompute). Name-based and idempotent: a failed
 * tool still triggers a harmless recompute.
 */
export const makeRefreshScopesFromTurn =
  (refresh: Map<string, readonly RefreshScope[]>) =>
  (state: BotStateType): Set<RefreshScope> => {
    const lastAi = [...state.messages]
      .reverse()
      .find((m) => m.getType() === 'ai') as AIMessage | undefined;
    const out = new Set<RefreshScope>();
    for (const c of lastAi?.tool_calls ?? []) {
      for (const s of refresh.get(c.name) ?? []) out.add(s);
    }
    return out;
  };

/**
 * Out of `tool_loop_guard` (built per-bot — closes over the bot's refresh map). EVERY tool batch
 * flows through here (a plain edge out of `tools`); no tool ends the turn directly. The guard node
 * has already written `toolLoopVerdict`:
 *  - `pause`   → a stuck loop persisted after a correction; end the turn (reconcile).
 *  - `correct` → first stuck verdict; force a context refresh so the bot sees reality.
 *  - else (`pass`/undefined) → refreshContext if any call dirtied context, otherwise straight to llm
 *    (where the bot sees any tool result — including an error ToolMessage — and decides what's next).
 */
export const makeAfterToolLoopGuard =
  (refresh: Map<string, readonly RefreshScope[]>) =>
  (state: BotStateType): 'llm' | 'refreshContext' | 'reconcile' => {
    if (state.toolLoopVerdict === 'pause') return 'reconcile';
    if (state.toolLoopVerdict === 'correct') return 'refreshContext';
    const scopes = makeRefreshScopesFromTurn(refresh)(state);
    return scopes.size ? 'refreshContext' : 'llm';
  };
