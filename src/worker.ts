import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent } from 'langchain';
import { updateJob } from './jobs.js';
import { buildModel } from './model.js';
import { ZERO_WORKER_PROMPT } from './persona.js';
import { workerTools } from './tools.js';

// Uses `createAgent` from `langchain` (the current API; `createReactAgent` from
// @langchain/langgraph/prebuilt is deprecated). model/tools/systemPrompt/checkpointer.
let worker: ReturnType<typeof build> | undefined;

function build() {
  return createAgent({
    model: buildModel(),
    tools: workerTools,
    systemPrompt: ZERO_WORKER_PROMPT,
    checkpointer: new MemorySaver(),
  });
}

const getWorker = () => (worker ??= build());

/** Coerce message content (string | content blocks) to a flat string. */
function asText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) => (typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join('')
    .trim();
}

/**
 * Run a job to completion on its own thread, then mark it done/failed in the registry.
 * Fire-and-forget from the caller's perspective — errors are caught here so there's never an
 * unhandled rejection. This is the background execution that keeps the chat responsive.
 */
export async function runJob(jobId: string, task: string): Promise<void> {
  const threadId = `job:${jobId}`;
  try {
    const final = await getWorker().invoke(
      { messages: [new HumanMessage(task)] },
      { configurable: { thread_id: threadId }, recursionLimit: 50 },
    );
    const messages = final.messages as BaseMessage[];
    const last = messages[messages.length - 1];
    const result = asText(last?.content ?? '') || '(no summary)';
    updateJob(jobId, { status: 'done', result });
  } catch (err) {
    updateJob(jobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Read the worker's live state for a job and render its recent steps as a compact, narratable
 * string. Non-interrupting — pure read of the checkpoint. This is the "how's it going" channel.
 */
export async function getJobState(jobId: string): Promise<string> {
  const threadId = `job:${jobId}`;
  // createAgent's getState return type doesn't expose our state shape statically; read the
  // messages channel via a narrow cast (the runtime snapshot has values.messages).
  const snapshot = (await getWorker().getState({ configurable: { thread_id: threadId } })) as unknown as {
    values?: { messages?: BaseMessage[] };
  };
  const messages = snapshot.values?.messages ?? [];
  if (messages.length === 0) return 'No activity yet — the worker is just starting.';

  const recent = messages.slice(-8);
  const lines: string[] = [];
  for (const m of recent) {
    const type = m.getType();
    if (type === 'human') continue;
    if (type === 'ai') {
      const text = asText(m.content);
      const calls = (m as { tool_calls?: { name: string }[] }).tool_calls ?? [];
      if (text) lines.push(`thinking: ${text.slice(0, 200)}`);
      for (const c of calls) lines.push(`→ called ${c.name}`);
    } else if (type === 'tool') {
      lines.push(`  result: ${asText(m.content).slice(0, 160).replace(/\s+/g, ' ')}`);
    }
  }
  return lines.join('\n') || 'Working…';
}
