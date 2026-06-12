import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { EnvService } from '@core/config/env/env.service';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { PersonaService } from '../employees/persona.service';
import type { GateService } from '../gate/gate.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { BotGraphFactory } from './bot-graph.factory';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/**
 * Self-healing for a POISONED thread. LangGraph checkpoints per node, so an interruption between
 * the llm superstep (AI message WITH tool_calls committed) and the tools superstep (results
 * committed) leaves a dangling `tool_use` in the durable history — Anthropic then 400s EVERY
 * subsequent call on the thread (the live failure Dennis hit: INVALID_TOOL_RESULTS, repeating
 * until the retry cap, and surviving restarts now that checkpoints are Postgres). The llm node
 * must repair the history it sends — synthetic tool_results spliced in after any dangling
 * tool_use — so one interrupted turn is a hiccup, not a permanently bricked bot.
 */

class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private nextSeq = 0;
  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
    },
  ): ChannelMsg {
    const full = {
      ...msg,
      channelId: msg.channelId ?? this.surfaceId,
      seq: this.nextSeq++,
      createdAt: Date.now(),
    };
    this.log.push(full);
    return full;
  }
  since(cursor: number): ChannelMsg[] {
    return this.log.filter((m) => m.seq >= cursor);
  }
  get length(): number {
    return this.nextSeq;
  }
  lengthOf(): number {
    return this.nextSeq;
  }
  snapshot(): ChannelMsg[] {
    return [...this.log];
  }
  subscribe(): () => void {
    return () => {};
  }
}

const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'ctx',
  engine: EWorkerEngineName.CLAUDE,
};

describe('bot graph — poisoned-history self-healing', () => {
  it('splices synthetic tool_results after a dangling tool_use so the next turn succeeds', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, keep running recall until I say stop.',
    });

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        return new AIMessage({ content: 'Recovered and replying normally.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [],
        terminalToolNames: () => new Set<string>(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      { fetchContext: async () => '' } as unknown as FetchService,
      {
        reconcileMemory: async () => {},
        reconcileTasks: async () => {},
      } as unknown as ReconcileService,
      { buildModel: () => fakeModel } as unknown as ChatModelFactory,
      { chatPromptFor: () => 'persona' } as unknown as PersonaService,
      { list: () => [] } as unknown as WorktreeService,
      { list: async () => [] } as unknown as SessionRegistry,
      new MemorySaver() as unknown as PostgresSaver,
      { get: () => undefined } as unknown as EnvService,
    );

    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:poisoned:root' } };

    // Seed the poisoned checkpoint: the llm superstep committed an AI message calling `recall`,
    // then the turn was interrupted before the tools superstep — no ToolMessage ever landed.
    await graph.updateState(config, {
      messages: [
        new HumanMessage('Dennis: Alex, keep running recall until I say stop.'),
        new AIMessage({
          content: 'On it — running recall now.',
          tool_calls: [
            {
              name: 'recall',
              args: { query: 'project' },
              id: 'toolu_dangling_01',
              type: 'tool_call',
            },
          ],
        }),
      ],
      cursor: 1,
    });

    // A new message arrives; without the repair this turn would 400 forever (the live bug).
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Stop',
    });
    const stream = await graph.stream(
      { cursor: 1, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    expect(invocations).toHaveLength(1);
    const convo = invocations[0];
    // Find the dangling AI message in what was actually SENT to the model…
    const aiIdx = convo.findIndex(
      (m) =>
        m.getType() === 'ai' && ((m as AIMessage).tool_calls?.length ?? 0) > 0,
    );
    expect(aiIdx).toBeGreaterThan(-1);
    // …and assert a tool_result for its id sits IMMEDIATELY after (Anthropic's hard requirement).
    const next = convo[aiIdx + 1];
    expect(next.getType()).toBe('tool');
    expect((next as { tool_call_id?: string }).tool_call_id).toBe(
      'toolu_dangling_01',
    );

    // The turn completed: the reply landed and the cursor advanced past 'Stop'.
    const final = await graph.getState(config);
    expect(final.values.cursor).toBe(2);
    const lastAi = (final.values.messages as BaseMessage[])
      .filter((m) => m.getType() === 'ai')
      .at(-1);
    expect(lastAi && String(lastAi.content)).toContain('Recovered');
    // The repair is read-time only — the synthetic tool_result is NOT persisted into the checkpoint.
    expect(
      (final.values.messages as BaseMessage[]).some(
        (m) => m.getType() === 'tool',
      ),
    ).toBe(false);
  });

  it('leaves a healthy history (tool_use followed by its result) untouched', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'hi Alex',
    });

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        return new AIMessage({ content: 'hello!' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [],
        terminalToolNames: () => new Set<string>(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      { fetchContext: async () => '' } as unknown as FetchService,
      {
        reconcileMemory: async () => {},
        reconcileTasks: async () => {},
      } as unknown as ReconcileService,
      { buildModel: () => fakeModel } as unknown as ChatModelFactory,
      { chatPromptFor: () => 'persona' } as unknown as PersonaService,
      { list: () => [] } as unknown as WorktreeService,
      { list: async () => [] } as unknown as SessionRegistry,
      new MemorySaver() as unknown as PostgresSaver,
      { get: () => undefined } as unknown as EnvService,
    );

    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:healthy:root' } };
    const { ToolMessage } = await import('@langchain/core/messages');
    await graph.updateState(config, {
      messages: [
        new HumanMessage('Dennis: earlier message'),
        new AIMessage({
          content: '',
          tool_calls: [
            { name: 'recall', args: {}, id: 'toolu_ok_01', type: 'tool_call' },
          ],
        }),
        new ToolMessage({
          tool_call_id: 'toolu_ok_01',
          name: 'recall',
          content: 'facts…',
        }),
      ],
      cursor: 0,
    });

    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // Exactly one tool message in the sent convo — no synthetic duplicates were added.
    const toolMsgs = invocations[0].filter((m) => m.getType() === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as { content: unknown }).content).toBe('facts…');
  });
});
