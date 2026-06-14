import {
  AIMessage,
  HumanMessage,
  ToolMessage,
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
import { makeEmployee } from '@harness/employees/employee.testing';

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

const ALEX = makeEmployee({
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
});

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
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      {
        fetchMemory: async () => '',
        fetchTasks: async () => '',
      } as unknown as FetchService,
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

  it('does not attach cache_control to thinking blocks when the last history message is thinking-only', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Hello Alex',
    });

    const capturedConvos: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        capturedConvos.push(convo);
        return new AIMessage({ content: 'Hi there!' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [],
        terminalToolNames: () => new Set<string>(),
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      {
        fetchMemory: async () => '',
        fetchTasks: async () => '',
      } as unknown as FetchService,
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
    const config = { configurable: { thread_id: 'alex:thinking-cache:root' } };

    // Seed the checkpoint: the last history message is a thinking-only assistant turn —
    // only thinking/redacted_thinking blocks, no text block to anchor the cache breakpoint on.
    // Before the fix, withCacheBreakpoint would naively stamp cache_control on the last block
    // (a thinking block), which Anthropic rejects with a 400.
    await graph.updateState(config, {
      messages: [
        new HumanMessage('Dennis: Hello Alex'),
        new AIMessage({
          content: [
            {
              type: 'thinking',
              thinking: 'Let me reason about this carefully…',
            },
            { type: 'redacted_thinking', data: 'base64-opaque-blob' },
          ],
        }),
      ],
      cursor: 1,
    });

    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Still there?',
    });

    const stream = await graph.stream(
      { cursor: 1, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    expect(capturedConvos).toHaveLength(1);
    const convo = capturedConvos[0];

    // No thinking or redacted_thinking block in the conversation sent to the model should
    // carry cache_control — the fix must skip them when searching for the cache anchor.
    for (const msg of convo) {
      const content = (msg as { content: unknown }).content;
      if (typeof content !== 'string' && Array.isArray(content)) {
        for (const block of content as unknown[]) {
          if (
            typeof block === 'object' &&
            block !== null &&
            ((block as { type?: string }).type === 'thinking' ||
              (block as { type?: string }).type === 'redacted_thinking')
          ) {
            expect(
              (block as { cache_control?: unknown }).cache_control,
            ).toBeUndefined();
          }
        }
      }
    }
  });

  it('drops an orphaned leading tool_result when summarizedUpTo points at a ToolMessage', async () => {
    /**
     * Regression: compactionNode previously used a positional cut that could land on a ToolMessage.
     * When summarizedUpTo=2 and messages[2] is a ToolMessage, the verbatim tail starts with an
     * orphaned tool_result (its tool_use was summarized away). Anthropic 400s that history —
     * bricking the thread forever because llmNode runs BEFORE compactionNode each turn.
     *
     * The fix: dropLeadingOrphanToolResults strips the leading orphan at read-time (never persisted).
     */
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, give me a status update.',
    });

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        // No usage_metadata → compactionNode exits immediately; seeded summarizedUpTo stays.
        return new AIMessage({ content: 'All good.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [],
        terminalToolNames: () => new Set<string>(),
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      {
        fetchMemory: async () => '',
        fetchTasks: async () => '',
      } as unknown as FetchService,
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
    const config = { configurable: { thread_id: 'alex:orphan-tool-result:root' } };

    // Seed a poisoned checkpoint: summarizedUpTo=2, which points at the ToolMessage (idx 2).
    // This simulates a compaction cut that landed on a ToolMessage before the fix.
    //   idx 0: HumanMessage  (summarized)
    //   idx 1: AIMessage(tool_use t1)  (summarized)
    //   idx 2: ToolMessage(t1) ← summarizedUpTo POINTS HERE — orphaned leading tool_result
    //   idx 3: AIMessage('reply')  (verbatim tail)
    await graph.updateState(config, {
      messages: [
        new HumanMessage('Dennis: earlier question'),
        new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'recall',
              args: { query: 'status' },
              id: 'toolu_orphan_01',
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: 'toolu_orphan_01',
          name: 'recall',
          content: 'some recalled facts',
        }),
        new AIMessage({ content: 'Here is the status.' }),
      ],
      summarizedUpTo: 2,
      summary: 'Prior conversation: Dennis asked a question; Alex ran recall and replied.',
      cursor: 1,
    });

    // New message arrives.
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Thanks, can you elaborate?',
    });

    const stream = await graph.stream(
      { cursor: 1, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // The model was called exactly once (no 400 loop).
    expect(invocations).toHaveLength(1);
    const convo = invocations[0];

    // The orphaned tool_result for 'toolu_orphan_01' must NOT appear in the convo sent to the model.
    const orphanTool = convo.find(
      (m) =>
        m.getType() === 'tool' &&
        (m as ToolMessage).tool_call_id === 'toolu_orphan_01',
    );
    expect(orphanTool).toBeUndefined();

    // Invariant: every ToolMessage in the sent convo is immediately preceded by an AI with a
    // matching tool_call id.
    for (let i = 0; i < convo.length; i++) {
      if (convo[i].getType() !== 'tool') continue;
      const toolCallId = (convo[i] as ToolMessage).tool_call_id;
      const prev = convo[i - 1];
      expect(prev?.getType()).toBe('ai');
      const ownedIds = ((prev as AIMessage).tool_calls ?? []).map((c) => c.id);
      expect(ownedIds).toContain(toolCallId);
    }

    // Turn completed: reply landed and cursor advanced past the new message.
    const final = await graph.getState(config);
    expect(final.values.cursor).toBe(2);
    const lastAi = (final.values.messages as BaseMessage[])
      .filter((m) => m.getType() === 'ai')
      .at(-1);
    expect(lastAi && String(lastAi.content)).toContain('All good.');

    // Heal is read-time only — the checkpoint's summarizedUpTo is UNCHANGED at 2.
    expect(final.values.summarizedUpTo).toBe(2);
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
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
      {
        isEnabled: () => false,
        windowSize: () => 12,
        detect: () => Promise.resolve({ looping: false }),
      } as unknown as RecursionGuardService,
      {
        fetchMemory: async () => '',
        fetchTasks: async () => '',
      } as unknown as FetchService,
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
