import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable } from '@nestjs/common';
import { createAgent } from 'langchain';
import { flattenContent } from '../domain/text';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { planningTools, workerTools } from './worker-tools';
import {
  EWorkerEngineName,
  RunWorkerArgs,
  WorkerEngine,
} from './worker-engine.port';

/**
 * The original hand-rolled ReAct worker, one engine behind the WorkerEngine interface. Kept so the
 * harness can compare the custom LangGraph agent against Codex and Claude on the same task.
 */
@Injectable()
export class LanggraphEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.LANGGRAPH;

  // Two memoized agents, keyed by the planning flag. They share the checkpointer, so a session can
  // switch mode between turns (plan one turn, execute the next) and the other-mode agent resumes
  // the same thread — only the bound toolset differs.
  private agents = new Map<boolean, ReturnType<typeof createAgent>>();
  private threadCounter = 0;

  constructor(
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    private readonly models: ChatModelFactory,
  ) {}

  private getAgent(planning: boolean) {
    let a = this.agents.get(planning);
    if (!a) {
      // A plan turn gets a READ-ONLY tool set (no write_file/str_replace/bash) so a langgraph plan
      // turn physically cannot mutate the worktree — matching the engine-enforced read-only of the
      // claude/codex plan turns.
      a = createAgent({
        model: this.models.buildModel(),
        tools: planning ? planningTools : workerTools,
        checkpointer: this.checkpointer,
      });
      this.agents.set(planning, a);
    }
    return a;
  }

  async run({
    task,
    systemPrompt,
    sessionId,
    mode,
    onEvent,
    signal,
  }: RunWorkerArgs) {
    const threadId =
      sessionId ??
      `lg-${(++this.threadCounter).toString().padStart(3, '0')}-${Date.now()}`;
    // createAgent takes no per-invoke system prompt, so seed it as a leading SystemMessage on the
    // first turn only (resumes already carry it in the checkpointed history).
    const messages: BaseMessage[] = sessionId
      ? [new HumanMessage(task)]
      : [
          // Cache the worker's system prefix. Workers loop many times, so without a breakpoint the
          // persona is re-sent uncached on every iteration. ttl:'1h' survives long single tool calls.
          new SystemMessage({
            content: [
              {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
            ],
          }),
          new HumanMessage(task),
        ];

    let lastText = '';
    // streamMode 'updates' yields complete messages per node step (not token chunks), which maps
    // cleanly onto WorkerEvents. The update keys are node names; we don't depend on them.
    const stream = await this.getAgent(mode === 'plan').stream(
      { messages },
      {
        configurable: { thread_id: threadId },
        streamMode: 'updates',
        recursionLimit: 50,
        signal,
      },
    );
    for await (const update of stream as AsyncIterable<
      Record<string, { messages?: BaseMessage[] }>
    >) {
      for (const payload of Object.values(update)) {
        for (const m of payload?.messages ?? []) {
          if (m.getType() !== 'ai') continue;
          const text = flattenContent(m.content).trim();
          if (text) {
            onEvent({ kind: 'text', text });
            lastText = text;
          }
          for (const c of (m as { tool_calls?: { name: string }[] })
            .tool_calls ?? []) {
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
