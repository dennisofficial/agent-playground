import type { BaseMessage } from '@langchain/core/messages';

/**
 * Plain, render-ready view of the conversation. We derive these from the canonical LangGraph
 * message list (the checkpoint is the source of truth) rather than reconstructing from the
 * token stream — so tool calls are first-class and nothing drifts. A Slack renderer would
 * consume the same RenderItem shape.
 */
export type RenderItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; toolName: string }
  | { id: string; kind: 'error'; text: string };

/** Flatten message content (string | content blocks) to a plain string. */
export function messageText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) => (typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join('');
}

interface ToolCall {
  id?: string;
  name: string;
}

/**
 * Map canonical graph messages to render items. Caller passes only the messages not yet shown
 * (the list is append-only). Tool *result* messages are internal plumbing for the chat layer
 * and are omitted; an AI message's tool_calls become compact activity items instead.
 */
export function toRenderItems(messages: BaseMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  messages.forEach((m, i) => {
    const type = m.getType();
    const baseId = (m as { id?: string }).id ?? `${type}-${i}`;
    if (type === 'human') {
      items.push({ id: baseId, kind: 'user', text: messageText(m.content).trim() });
    } else if (type === 'ai') {
      const text = messageText(m.content).trim();
      if (text) items.push({ id: baseId, kind: 'assistant', text });
      const calls = ((m as { tool_calls?: ToolCall[] }).tool_calls ?? []);
      for (const c of calls) items.push({ id: `${baseId}:${c.id ?? c.name}`, kind: 'tool', toolName: c.name });
    }
    // tool-result messages: omitted from the chat transcript (internal).
  });
  return items;
}

export interface ContextUsage {
  input?: number;
  output?: number;
}
