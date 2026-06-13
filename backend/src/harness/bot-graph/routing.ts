import type { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RefreshScope } from '../tools/tool.types';
import type { BotStateType } from './bot-state';

/** Out of `gate`: the respond path flows through the loop guard first; ack/ignore goes straight
 * to `mark_seen`. */
export const route = (state: BotStateType): 'loop_guard' | 'mark_seen' =>
  state.decision === 'respond' ? 'loop_guard' : 'mark_seen';

/** Out of `loop_guard`: a confirmed loop routes to `pause`, otherwise proceeds to `recall`. */
export const afterGuard = (state: BotStateType): 'recall' | 'pause' =>
  state.loopBreak ? 'pause' : 'recall';

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
 * Derive the set of context scopes dirtied by the last tool batch. Used both by `makeAfterTools`
 * (to decide whether to insert a `refreshContext` superstep) and by `refreshContextNode` (to know
 * which slices to recompute). Name-based and idempotent: a failed tool still triggers a harmless
 * recompute — same posture as terminal detection.
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
 * Out of `tools` (built per-bot — closes over the bot's terminal-tool set and refresh map).
 *
 * Priority order:
 *  1. All calls are terminal AND none failed → end the turn (reconcile).
 *  2. Any terminal call failed → loop back to llm (bot sees the error ToolMessage).
 *  3. Non-terminal batch AND ≥1 call has a refresh scope → refreshContext before looping to llm.
 *  4. Non-terminal batch, no refresh scopes → straight back to llm (existing behavior).
 *
 * `every` (not `some`) is load-bearing for terminal: a message mixing a terminal tool with a
 * fallible one loops back so the result is relayed.
 */
export const makeAfterTools =
  (terminal: Set<string>, refresh: Map<string, readonly RefreshScope[]>) =>
  (state: BotStateType): 'llm' | 'refreshContext' | 'reconcile' => {
    const lastAi = [...state.messages]
      .reverse()
      .find((m) => m.getType() === 'ai') as AIMessage | undefined;
    const calls = lastAi?.tool_calls ?? [];
    const allTerminal =
      calls.length > 0 && calls.every((c) => terminal.has(c.name));
    if (allTerminal) {
      // Route back to llm when any terminal call failed — scan for ToolMessages whose call_id
      // belongs to the current AI message and whose status is 'error'.
      const callIds = new Set(
        calls.map((c) => c.id).filter(Boolean) as string[],
      );
      const anyFailed = state.messages.some(
        (m) =>
          m.getType() === 'tool' &&
          callIds.has((m as ToolMessage).tool_call_id) &&
          (m as ToolMessage).status === 'error',
      );
      return anyFailed ? 'llm' : 'reconcile';
    }
    // Non-terminal batch: check if any call dirtied context.
    const scopes = makeRefreshScopesFromTurn(refresh)(state);
    return scopes.size ? 'refreshContext' : 'llm';
  };
