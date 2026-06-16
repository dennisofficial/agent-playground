import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { z } from 'zod';
import type { EnvService } from '@core/config/env/env.service';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { PersonaService } from '../employees/persona.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { makeEmployee } from '@harness/employees/employee.testing';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * Post-tools context refresh node (TKT-14). After a tool batch that mutates work/memory/tasks
 * state, the `refreshContext` node recomputes ONLY the dirtied context slices before the next
 * model call — so the bot reasons against fresh state, not a frozen pre-turn snapshot.
 *
 * Invariants:
 *   (1) work refresh:    worktree list change is visible in the next model call
 *   (2) memory refresh:  fetchMemory change is visible in the next model call
 *   (4) untagged → no route:   non-refresh tool loops straight back to llm (original behavior)
 *   (5) single recall event:   `recalled` stays the pre-LLM snapshot; refresh updates only `context`
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
    const full: ChannelMsg = {
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

const flat = (c: BaseMessage['content']): string =>
  typeof c === 'string'
    ? c
    : c
        .map((p) =>
          typeof p === 'object' && 'text' in p
            ? (p as { text: string }).text
            : '',
        )
        .join('');

/** Drain a graph turn and return all recorded model invocations. */
async function runTurn(
  factory: BotGraphFactory,
  threadId: string,
): Promise<void> {
  const graph = factory.getConductorGraph(ALEX);
  const config = { configurable: { thread_id: threadId } };
  const stream = await graph.stream(
    { cursor: 0, forced: false },
    { ...config, streamMode: 'updates' as const },
  );
  for await (const _ of stream) {
    /* drain */
  }
}

describe('bot graph — post-tools context refresh', () => {
  it('(1) work refresh: updated worktree list is visible in the post-refresh llm call', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, create a worktree.',
    });

    // Counter-based list mock: first call (during recallNode) → no trees, second (refreshContext) → one.
    let listCallCount = 0;
    const worktrees: WorktreeService = {
      list: () => {
        listCallCount++;
        if (listCallCount <= 1) return [];
        return [
          {
            id: 'wt-new',
            name: 'feature',
            branch: 'alex/feature',
            ownerBot: 'alex',
            sharedBranch: undefined,
            project: 'myproject',
          } as unknown as ReturnType<WorktreeService['list']>[0],
        ];
      },
    } as unknown as WorktreeService;

    // A tool tagged ['work'] — its execution simulates the worktree being created.
    const pokeTool = tool(async () => 'wt-new created', {
      name: 'poke',
      description: 'no-op probe',
      schema: z.object({}),
    });

    const invocations: BaseMessage[][] = [];
    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        callCount++;
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'Done.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        refreshScopesByName: () => new Map([['poke', ['work'] as const]]),
      } as unknown as ToolRegistry,
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
      worktrees,
      { list: async () => [] } as unknown as SessionRegistry,
      new MemorySaver() as unknown as PostgresSaver,
      { get: () => undefined } as unknown as EnvService,
    );

    await runTurn(factory, 'alex:refresh-work:root');

    expect(invocations).toHaveLength(2);
    // Step 1 — before the tool ran: no worktree in context yet.
    const step1 = invocations[0].map((m) => flat(m.content)).join('\n');
    expect(step1).not.toContain('wt-new');
    // Step 2 — after refreshContext: the new worktree line must be present.
    const step2 = invocations[1].map((m) => flat(m.content)).join('\n');
    expect(step2).toContain('wt-new');

    // Final state: context.work updated, recalled still the original (empty) snapshot.
    const graph = factory.getConductorGraph(ALEX);
    const final = await graph.getState({
      configurable: { thread_id: 'alex:refresh-work:root' },
    });
    expect(
      (final.values as { context: { work: string } }).context.work,
    ).toContain('wt-new');
    // recalled is the pre-LLM snapshot written by recallNode — NOT updated by refreshContext.
    expect((final.values as { recalled: string }).recalled).toBe('');
  });

  it('(2) memory refresh: updated fetchMemory result is visible in the post-refresh llm call', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, remember something.',
    });

    // Counter-based fetchMemory: first call returns M1 (recallNode), second returns M2 (refreshContext).
    let fetchCount = 0;
    const fetchService: FetchService = {
      fetchMemory: async () => {
        fetchCount++;
        return fetchCount <= 1 ? 'M1: initial memory' : 'M2: updated memory';
      },
      fetchTasks: async () => '',
    } as unknown as FetchService;

    const pokeTool = tool(async () => 'remembered', {
      name: 'poke',
      description: 'no-op probe',
      schema: z.object({}),
    });

    const invocations: BaseMessage[][] = [];
    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        callCount++;
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'Noted.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        refreshScopesByName: () => new Map([['poke', ['memory'] as const]]),
      } as unknown as ToolRegistry,
      fetchService,
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

    await runTurn(factory, 'alex:refresh-memory:root');

    expect(invocations).toHaveLength(2);
    // Step 1 sees M1 (the initial fetchMemory result from recallNode).
    const step1 = invocations[0].map((m) => flat(m.content)).join('\n');
    expect(step1).toContain('M1: initial memory');
    expect(step1).not.toContain('M2: updated memory');
    // Step 2 sees M2 (the refreshed fetchMemory result from refreshContextNode).
    const step2 = invocations[1].map((m) => flat(m.content)).join('\n');
    expect(step2).toContain('M2: updated memory');
  });

  it('(4) untagged → no route: non-refresh tool loops straight back to llm (existing behavior)', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, poke.',
    });

    // Simulates a mid-turn message so the second step has something to see.
    const pokeTool = tool(
      async () => {
        channel.append({
          id: 'u-1',
          author: 'Dennis',
          authorId: 'dennis',
          text: 'You can stop',
        });
        return 'poked';
      },
      { name: 'poke', description: 'no-op probe', schema: z.object({}) },
    );

    const invocations: BaseMessage[][] = [];
    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        callCount++;
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'Stopped.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        // Empty map → poke has NO refresh scope → routes straight to llm after tools.
        refreshScopesByName: () => new Map(),
      } as unknown as ToolRegistry,
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

    await runTurn(factory, 'alex:refresh-untagged:root');

    expect(invocations).toHaveLength(2);
    // Mid-turn message injection still works: step 2 sees "You can stop".
    const step2 = invocations[1].map((m) => flat(m.content)).join('\n');
    expect(step2).toContain('You can stop');
  });

  it('(5) single recall event: recalled stays the pre-LLM snapshot even after a work refresh', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, create a worktree.',
    });

    // Counter-based: recallNode (call 1) → empty; refreshContext (call 2) → new worktree.
    let listCount = 0;
    const worktrees: WorktreeService = {
      list: () => {
        listCount++;
        return listCount <= 1
          ? []
          : [
              {
                id: 'wt-new',
                name: 'feature',
                branch: 'alex/feature',
                ownerBot: 'alex',
                sharedBranch: undefined,
                project: 'myproject',
              } as unknown as ReturnType<WorktreeService['list']>[0],
            ];
      },
    } as unknown as WorktreeService;

    const pokeTool = tool(async () => 'created', {
      name: 'poke',
      description: 'no-op probe',
      schema: z.object({}),
    });

    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke() {
        callCount++;
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'Done.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        refreshScopesByName: () => new Map([['poke', ['work'] as const]]),
      } as unknown as ToolRegistry,
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
      worktrees,
      { list: async () => [] } as unknown as SessionRegistry,
      new MemorySaver() as unknown as PostgresSaver,
      { get: () => undefined } as unknown as EnvService,
    );

    await runTurn(factory, 'alex:refresh-single-recall:root');

    const graph = factory.getConductorGraph(ALEX);
    const final = await graph.getState({
      configurable: { thread_id: 'alex:refresh-single-recall:root' },
    });

    // `context.work` was updated by refreshContext — the new worktree is there.
    expect(
      (final.values as { context: { work: string } }).context.work,
    ).toContain('wt-new');

    // `recalled` was written by recallNode (before the tool ran) and must NOT have been updated
    // by refreshContext. The recallNode saw an empty worktree list, so recalled = ''.
    expect((final.values as { recalled: string }).recalled).toBe('');
  });
});
