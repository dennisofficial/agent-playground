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
import type { GateService } from '../gate/gate.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * Pins the rule: a failed terminal tool call MUST NOT silently end the turn.
 *
 * When a terminal tool produces a ToolMessage with status:'error' (i.e. it threw), `afterTools`
 * must route back to `llm` so the model can observe the failure and respond — not to RECONCILE,
 * which would end the turn with the error invisible to the user.
 *
 * Three cases:
 *  (a) terminal tool throws → loop back to llm, model invoked twice
 *  (b) terminal tool succeeds → end turn immediately, model invoked once
 *  (c) partial failure (one terminal succeeds, one throws) → loop to llm, model invoked twice
 */

class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private nextSeq = 0;
  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'>,
  ): ChannelMsg {
    const full = {
      ...msg,
      channelId: this.surfaceId,
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
}

const ALEX = {
  id: 'alex',
  name: 'Alex',
  role: 'backend engineer',
  sortOrder: 10,
  roleContext: 'ctx',
  engine: EWorkerEngineName.CLAUDE,
};

describe('bot graph — terminal tool error handling', () => {
  it('(a) terminal tool that throws loops back to llm — model invoked twice', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, do the thing.',
    });

    // A terminal tool that always throws — ToolNode will catch it and set status:'error'.
    const terminalThrower = tool(
      async () => {
        throw new Error('worktree not found');
      },
      {
        name: 'finish_work',
        description: 'terminal, always throws',
        schema: z.object({}),
      },
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
        // Step 1: call the terminal tool. Step 2 (after loop-back): plain reply.
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  name: 'finish_work',
                  args: {},
                  id: 'call_err_1',
                  type: 'tool_call',
                },
              ],
            })
          : new AIMessage({ content: 'Tool failed — I will flag it.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [terminalThrower],
        terminalToolNames: () => new Set(['finish_work']),
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
    const config = { configurable: { thread_id: 'alex:term-err-a:root' } };
    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // The error ToolMessage must have looped the graph back to llm for a second model call.
    expect(invocations).toHaveLength(2);
  });

  it('(b) terminal tool success ends the turn — model invoked once', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, do the thing.',
    });

    // A terminal tool that succeeds — ToolNode sets status:'success'.
    const terminalOk = tool(async () => 'Session opened.', {
      name: 'finish_work',
      description: 'terminal, always succeeds',
      schema: z.object({}),
    });

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        // Always returns a terminal tool call — if routing is broken the model would be invoked
        // a second time with this same response and the test would catch the infinite loop.
        return new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'finish_work',
              args: {},
              id: 'call_ok_1',
              type: 'tool_call',
            },
          ],
        });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [terminalOk],
        terminalToolNames: () => new Set(['finish_work']),
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
    const config = { configurable: { thread_id: 'alex:term-ok-b:root' } };
    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // Successful terminal call goes straight to reconcile — the model is never called a second time.
    expect(invocations).toHaveLength(1);
  });

  it('(c) partial failure — one terminal succeeds, one throws — loops to llm', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, do two things.',
    });

    const terminalOk = tool(async () => 'Session A opened.', {
      name: 'finish_ok',
      description: 'terminal, succeeds',
      schema: z.object({}),
    });
    const terminalBad = tool(
      async () => {
        throw new Error('session B failed');
      },
      {
        name: 'finish_bad',
        description: 'terminal, throws',
        schema: z.object({}),
      },
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
        // Step 1: call both terminal tools. Step 2 (after loop-back): plain reply.
        return callCount === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                {
                  name: 'finish_ok',
                  args: {},
                  id: 'call_ok_1',
                  type: 'tool_call',
                },
                {
                  name: 'finish_bad',
                  args: {},
                  id: 'call_bad_1',
                  type: 'tool_call',
                },
              ],
            })
          : new AIMessage({ content: 'Handled partial failure.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [terminalOk, terminalBad],
        terminalToolNames: () => new Set(['finish_ok', 'finish_bad']),
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
    const config = { configurable: { thread_id: 'alex:term-partial-c:root' } };
    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // One error ToolMessage among the batch is enough to loop back — the model is called twice.
    expect(invocations).toHaveLength(2);
  });
});
