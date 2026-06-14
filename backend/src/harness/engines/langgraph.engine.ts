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
import { calculateCost, extractMessageUsage } from '../llm/usage-format';
import type { MessageUsage } from '../domain/conductor-events';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { planningTools, workerTools } from './worker-tools';
import {
  EWorkerEngineName,
  IWorkerUsage,
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

  private getAgent(readOnly: boolean) {
    let a = this.agents.get(readOnly);
    if (!a) {
      // A read-only turn (plan or investigate) gets a READ-ONLY tool set (no write_file/str_replace/
      // bash) so it physically cannot mutate the worktree — matching the engine-enforced read-only of
      // the claude/codex read-only turns. LangGraph has no separate plan ceremony, so plan and
      // investigate share this read-only agent; only their opening-prompt framing differs.
      a = createAgent({
        model: this.models.buildModel(),
        tools: readOnly ? planningTools : workerTools,
        checkpointer: this.checkpointer,
      });
      this.agents.set(readOnly, a);
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
    // Accumulate token usage across all AI messages in this turn.
    const accUsage: MessageUsage = { input: 0, output: 0 };

    // streamMode 'updates' yields complete messages per node step (not token chunks), which maps
    // cleanly onto WorkerEvents. The update keys are node names; we don't depend on them.
    const stream = await this.getAgent(mode !== 'execute').stream(
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
          // Accumulate token usage from every AI message (each step has usage_metadata).
          const u = extractMessageUsage(m);
          if (u) {
            accUsage.input += u.input;
            accUsage.output += u.output;
            accUsage.cacheRead = (accUsage.cacheRead ?? 0) + (u.cacheRead ?? 0);
            accUsage.cacheWrite5m =
              (accUsage.cacheWrite5m ?? 0) + (u.cacheWrite5m ?? 0);
            accUsage.cacheWrite1h =
              (accUsage.cacheWrite1h ?? 0) + (u.cacheWrite1h ?? 0);
          }
        }
      }
    }

    const result = lastText || '(no summary)';
    onEvent({ kind: 'result', text: result });

    // Build IWorkerUsage from the accumulated counts. LangGraph always uses the chat model (the
    // engine ignores `turnModel` — `getAgent` calls `this.models.buildModel()` unconditionally).
    let workerUsage: IWorkerUsage | undefined;
    if (accUsage.input > 0 || accUsage.output > 0) {
      const modelId = this.models.chatModelId();
      const cacheRead = accUsage.cacheRead ?? 0;
      const cacheWrite5m = accUsage.cacheWrite5m ?? 0;
      const cacheWrite1h = accUsage.cacheWrite1h ?? 0;
      const cacheWrite = cacheWrite5m + cacheWrite1h;
      const costUsd = calculateCost(modelId, accUsage);
      workerUsage = {
        // LangChain's usage_metadata already folds cache tokens into `input_tokens` (grand total).
        inputTokens: accUsage.input,
        outputTokens: accUsage.output,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
        costUsd,
        model: modelId,
      };
    }

    return {
      result,
      sessionId: threadId,
      ...(workerUsage ? { usage: workerUsage } : {}),
    };
  }
}
