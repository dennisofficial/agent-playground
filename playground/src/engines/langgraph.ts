import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createAgent } from 'langchain';
import { getCheckpointer } from '../memory/checkpointer.js';
import { buildModel } from '../model.js';
import { workerTools } from '../tools.js';
import type { RunWorkerArgs, WorkerEngine } from './types.js';

// The original hand-rolled worker, now one engine behind the WorkerEngine interface. Kept so the
// playground can compare the custom LangGraph agent against Codex and Claude on the same task.
let agent: ReturnType<typeof build> | undefined;

function build() {
  return createAgent({ model: buildModel(), tools: workerTools, checkpointer: getCheckpointer() });
}

const getAgent = () => (agent ??= build());

/** Coerce message content (string | content blocks) to a flat string. */
function asText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) =>
      typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : '',
    )
    .join('')
    .trim();
}

let threadCounter = 0;

export const langgraphEngine: WorkerEngine = {
  name: 'langgraph',
  async run({ task, systemPrompt, sessionId, onEvent }: RunWorkerArgs) {
    const threadId = sessionId ?? `lg-${(++threadCounter).toString().padStart(3, '0')}`;
    // createAgent takes no per-invoke system prompt, so seed it as a leading SystemMessage on the
    // first turn only (resumes already carry it in the checkpointed history).
    const messages: BaseMessage[] = sessionId
      ? [new HumanMessage(task)]
      : [new SystemMessage(systemPrompt), new HumanMessage(task)];

    let lastText = '';
    // streamMode 'updates' yields complete messages per node step (not token chunks), which maps
    // cleanly onto WorkerEvents. The update keys are node names; we don't depend on them.
    const stream = await getAgent().stream(
      { messages },
      { configurable: { thread_id: threadId }, streamMode: 'updates', recursionLimit: 50 },
    );
    for await (const update of stream as AsyncIterable<
      Record<string, { messages?: BaseMessage[] }>
    >) {
      for (const payload of Object.values(update)) {
        for (const m of payload?.messages ?? []) {
          if (m.getType() !== 'ai') continue;
          const text = asText(m.content);
          if (text) {
            onEvent({ kind: 'text', text });
            lastText = text;
          }
          for (const c of (m as { tool_calls?: { name: string }[] }).tool_calls ?? []) {
            onEvent({ kind: 'tool', name: c.name });
          }
        }
      }
    }

    const result = lastText || '(no summary)';
    onEvent({ kind: 'result', text: result });
    return { result, sessionId: threadId };
  },
};
