import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { z } from 'zod';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { PersonaService } from '../employees/persona.service';
import type { GateService } from '../gate/gate.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorktreeService } from '../worktrees/worktree.service';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * THE HEART of the harness — mid-thought collaboration. The `llm` node consumes
 * `channel.since(cursor)` at the TOP of EVERY step, so a message that lands WHILE the bot is
 * looping through tools is folded into its very next model call — not batched until the next turn.
 * This spec pins that behavior deterministically (scripted model, no LLM): a message arrives while
 * a tool call is executing, and the NEXT model step must see it in its input.
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
  engine: 'claude' as const,
};

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

describe('bot graph — mid-thought message injection', () => {
  it('folds a message that lands during a tool call into the very next model step', async () => {
    const channel = new FakeChannel();
    // The conversation so far: Dennis asks Alex to loop on tools.
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, keep running tool calls until I tell you to stop.',
    });

    // A tool whose EXECUTION is when the human's next message lands — mid-turn, between llm steps.
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

    // Scripted model: step 1 calls the tool; step 2 (and later) just answers. Records every input.
    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        return invocations.length === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'Stopped! I saw your message mid-turn.' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        terminalToolNames: () => new Set<string>(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
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
    );

    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:test:root' } };
    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    expect(invocations).toHaveLength(2);
    // Step 1 sees only the original ask — the stop message doesn't exist yet.
    const step1 = invocations[0].map((m) => flat(m.content)).join('\n');
    expect(step1).toContain('keep running tool calls');
    expect(step1).not.toContain('You can stop');
    // Step 2 — the SAME turn, right after the tool ran — must already see the mid-turn message.
    const step2Tail = invocations[1]
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));
    expect(step2Tail.some((t) => t.includes('Dennis: You can stop'))).toBe(
      true,
    );

    // And the checkpoint commits the injection atomically: both human messages are durable history,
    // and the cursor has advanced past everything consumed.
    const final = await graph.getState(config);
    expect(final.values.cursor).toBe(2);
    const history = (final.values.messages as BaseMessage[])
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));
    expect(history).toEqual([
      'Dennis: Alex, keep running tool calls until I tell you to stop.',
      'Dennis: You can stop',
    ]);
  });

  it('does NOT inject mid-turn messages the bot authored itself (own messages are skipped)', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, run one tool.',
    });

    const pokeTool = tool(
      async () => {
        // The bot's OWN reply landing on the channel mid-turn must not be re-consumed as input.
        channel.append({
          id: 'alex:0',
          author: 'Alex',
          authorId: 'alex',
          authorBotId: 'alex',
          text: 'working on it',
        });
        return 'poked';
      },
      { name: 'poke', description: 'no-op probe', schema: z.object({}) },
    );

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        return invocations.length === 1
          ? new AIMessage({
              content: '',
              tool_calls: [
                { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
              ],
            })
          : new AIMessage({ content: 'done' });
      },
    };

    const factory = new BotGraphFactory(
      channel as unknown as ChannelService,
      { get: () => undefined } as unknown as ChannelRegistryService,
      {
        toStructuredTools: () => [pokeTool],
        terminalToolNames: () => new Set<string>(),
      } as unknown as ToolRegistry,
      {
        gate: async () => ({ action: 'respond' as const }),
      } as unknown as GateService,
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
    );

    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:test2:root' } };
    const stream = await graph.stream(
      { cursor: 0, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    const step2 = invocations[1].map((m) => flat(m.content)).join('\n');
    expect(step2).not.toContain('Alex: working on it'); // own message never re-injected
    // …but the cursor still moves past it (own messages are skipped, not left pending).
    const final = await graph.getState(config);
    expect(final.values.cursor).toBe(2);
  });
});
