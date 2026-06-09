import type { BaseMessage } from '@langchain/core/messages';

/**
 * Plain, render-ready view of the conversation. We derive these from the canonical LangGraph
 * message list (the checkpoint is the source of truth) rather than reconstructing from the
 * token stream — so tool calls are first-class and nothing drifts. A Slack renderer would
 * consume the same RenderItem shape.
 */
export type RenderItem =
  | { id: string; kind: 'user'; text: string; speaker?: string; ts?: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      speaker?: string;
      ts?: string;
      /** Per-message token usage from the model call that produced it; rendered dim at the end. */
      usage?: MessageUsage;
    }
  | { id: string; kind: 'tool'; toolName: string; speaker?: string }
  | { id: string; kind: 'reaction'; emoji: string; by: string }
  // Debug only: the response gate's verdict + rationale for a bot, shown inline so you can see why a
  // bot spoke, reacted, or (importantly) stayed silent. Only soft-gate (LLM) calls carry a reason.
  | {
      id: string;
      kind: 'gate';
      by: string;
      action: 'respond' | 'acknowledge' | 'ignore';
      reasoning: string;
    }
  // CLI-local output for a slash command (e.g. /tasks dumping the open board) — never a chat message.
  | { id: string; kind: 'note'; text: string }
  // Debug only: the pre-LLM fetch — what memory/tasks the bot walked in knowing this turn.
  | { id: string; kind: 'recall'; by: string; text: string }
  | { id: string; kind: 'error'; text: string };

/** Flatten message content (string | content blocks) to a plain string. */
export function messageText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) =>
      typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : '',
    )
    .join('');
}

interface ToolCall {
  id?: string;
  name: string;
}

/**
 * Map canonical graph messages to render items. Caller passes only the messages not yet shown
 * (the list is append-only). Tool *result* messages are internal plumbing for the chat layer
 * and are omitted; an AI message's tool_calls become compact activity items instead. `botName`
 * labels the assistant line with the responding bot (multiple bots share the channel).
 */
export function toRenderItems(messages: BaseMessage[], botName?: string): RenderItem[] {
  const items: RenderItem[] = [];
  messages.forEach((m, i) => {
    const type = m.getType();
    const baseId = (m as { id?: string }).id ?? `${type}-${i}`;
    if (type === 'human') {
      items.push({ id: baseId, kind: 'user', text: messageText(m.content).trim() });
    } else if (type === 'ai') {
      const text = messageText(m.content).trim();
      if (text) items.push({ id: baseId, kind: 'assistant', text, speaker: botName });
      const calls = (m as { tool_calls?: ToolCall[] }).tool_calls ?? [];
      for (const c of calls)
        items.push({
          id: `${baseId}:${c.id ?? c.name}`,
          kind: 'tool',
          toolName: c.name,
          speaker: botName,
        });
    }
    // tool-result messages: omitted from the chat transcript (internal).
  });
  return items;
}

export interface ContextUsage {
  input?: number;
  output?: number;
}

/**
 * Per-message token usage, broken out so the renderer can show cache hits. `input` is the TOTAL input
 * tokens (langchain folds cache reads + writes into it); `cacheRead`/`cacheWrite` are the cached slices
 * of that total — `cacheRead` served at ~0.1× price, `cacheWrite` written this call at ~1.25×.
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** One-line dim token summary shown at the end of a rendered assistant message, e.g. `812 in · 96 out · 640 cached`. */
export function formatMessageUsage(u: MessageUsage): string {
  const parts = [`${u.input} in`, `${u.output} out`];
  if (u.cacheRead) parts.push(`${u.cacheRead} cached`);
  if (u.cacheWrite) parts.push(`${u.cacheWrite} cache-write`);
  return parts.join(' · ');
}
