import type { AIMessage, ToolMessage } from '@langchain/core/messages';
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
 * Out of `tools` (built per-bot — closes over the bot's terminal-tool set).
 *
 * After tools run, END the turn (skip the loop back to `llm` that would otherwise force a chatty
 * text-only follow-up) when EVERY call in the triggering message is terminal AND all succeeded.
 * `every` (not `some`) is load-bearing: a message mixing a terminal tool with an informational or
 * fallible one loops back so that result is relayed. If any terminal call has status:'error' we
 * also loop back — a failed terminal tool must not silently end the turn; the model needs a chance
 * to react to the error ToolMessage.
 */
export const makeAfterTools =
  (terminal: Set<string>) =>
  (state: BotStateType): 'llm' | 'reconcile' => {
    const lastAi = [...state.messages]
      .reverse()
      .find((m) => m.getType() === 'ai') as AIMessage | undefined;
    const calls = lastAi?.tool_calls ?? [];
    const allTerminal =
      calls.length > 0 && calls.every((c) => terminal.has(c.name));
    if (!allTerminal) return 'llm';
    // Route back to llm when any terminal call failed — scan for ToolMessages whose call_id
    // belongs to the current AI message and whose status is 'error'.
    const callIds = new Set(calls.map((c) => c.id).filter(Boolean) as string[]);
    const anyFailed = state.messages.some(
      (m) =>
        m.getType() === 'tool' &&
        callIds.has((m as ToolMessage).tool_call_id) &&
        (m as ToolMessage).status === 'error',
    );
    return anyFailed ? 'llm' : 'reconcile';
  };
