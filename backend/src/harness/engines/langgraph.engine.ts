import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable } from '@nestjs/common';
import { createAgent } from 'langchain';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { CHECKPOINTER } from '../memory/memory.module';
import { planningTools, workerTools } from './worker-tools';
import type { RunWorkerArgs, WorkerEngine } from './worker-engine.port';

/** Coerce message content (string | content blocks) to a flat string. */
function asText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((c) => (typeof c === 'string' ? c : 'text' in c && typeof c.text === 'string' ? c.text : ''))
    .join('')
    .trim();
}

/**
 * The original hand-rolled ReAct worker, one engine behind the WorkerEngine interface. Kept so the
 * harness can compare the custom LangGraph agent against Codex and Claude on the same task.
 */
@Injectable()
export class LanggraphEngine implements WorkerEngine {
  readonly name = 'langgraph' as const;

  // Two memoized agents, keyed by the planning flag. A job never switches mode mid-life (plan jobs
  // stay planning=true across resumes; execute jobs are planning=false).
  private agents = new Map<boolean, ReturnType<typeof createAgent>>();
  private threadCounter = 0;

  constructor(
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    private readonly models: ChatModelFactory,
  ) {}

  private getAgent(planning: boolean) {
    let a = this.agents.get(planning);
    if (!a) {
      // A PLAN pass gets a READ-ONLY tool set (no write_file/str_replace/bash) so a langgraph plan
      // job physically cannot mutate the repo — matching the engine-enforced read-only of the
      // claude/codex planning passes.
      a = createAgent({
        model: this.models.buildModel(),
        tools: planning ? planningTools : workerTools,
        checkpointer: this.checkpointer,
      });
      this.agents.set(planning, a);
    }
    return a;
  }

  async run({ task, systemPrompt, sessionId, planning, onEvent, signal }: RunWorkerArgs) {
    const threadId = sessionId ?? `lg-${(++this.threadCounter).toString().padStart(3, '0')}-${Date.now()}`;
    // createAgent takes no per-invoke system prompt, so seed it as a leading SystemMessage on the
    // first turn only (resumes already carry it in the checkpointed history).
    const messages: BaseMessage[] = sessionId
      ? [new HumanMessage(task)]
      : [
          // Cache the worker's system prefix. Workers loop many times, so without a breakpoint the
          // persona is re-sent uncached on every iteration. ttl:'1h' survives long single tool calls.
          new SystemMessage({
            content: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          }),
          new HumanMessage(task),
        ];

    let lastText = '';
    // streamMode 'updates' yields complete messages per node step (not token chunks), which maps
    // cleanly onto WorkerEvents. The update keys are node names; we don't depend on them.
    const stream = await this.getAgent(planning ?? false).stream(
      { messages },
      { configurable: { thread_id: threadId }, streamMode: 'updates', recursionLimit: 50, signal },
    );
    for await (const update of stream as AsyncIterable<Record<string, { messages?: BaseMessage[] }>>) {
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
  }
}
