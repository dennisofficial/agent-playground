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

/**
 * Pins the recursion guard's four critical behaviours:
 *   (a) loop detected → no llm call, pause message committed, cursor advanced
 *   (b) no loop detected → normal fetch→llm path proceeds
 *   (c) human-authored trigger → guard.detect never called
 *   (d) forced turn (job relay) → guard.detect never called
 *
 * The other bot-graph specs set `isEnabled: () => false` so the guard can't interfere with
 * their assertions. This spec enables it selectively.
 */

interface CheckpointValues {
  messages: BaseMessage[];
  cursor: number;
}

class FakeChannel {
  readonly surfaceId = 'tui:test';
  private log: ChannelMsg[] = [];
  private nextSeq = 0;

  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
      createdAt?: number;
    },
  ): ChannelMsg {
    const full: ChannelMsg = {
      ...msg,
      channelId: msg.channelId ?? this.surfaceId,
      seq: this.nextSeq++,
      createdAt: msg.createdAt ?? Date.now(),
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

/** Seed N AI messages (prior turns) to satisfy the guard's GUARD_FLOOR minimum. */
const priorAiHistory = (n: number): AIMessage[] =>
  Array.from(
    { length: n },
    (_, i) => new AIMessage({ content: `prior response ${i + 1}` }),
  );

/** A fake model that records every invocation and replies with a fixed string. */
function scriptedModel(
  reply: string,
  invocations: BaseMessage[][],
): ChatModelFactory {
  return {
    buildModel: () => ({
      bindTools() {
        return this;
      },
      invoke(convo: BaseMessage[]) {
        invocations.push(convo);
        return Promise.resolve(new AIMessage({ content: reply }));
      },
    }),
  } as unknown as ChatModelFactory;
}

/** Standard harness shared across all cases — only `guard` and `model` vary. */
function buildFactory(
  channel: FakeChannel,
  guard: RecursionGuardService,
  model: ChatModelFactory,
): BotGraphFactory {
  return new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined } as unknown as ChannelRegistryService,
    {
      toStructuredTools: () => [],
      terminalToolNames: () => new Set<string>(),
    } as unknown as ToolRegistry,
    {
      gate: () => Promise.resolve({ action: 'respond' as const }),
    } as unknown as GateService,
    guard,
    { fetchContext: () => Promise.resolve('') } as unknown as FetchService,
    {
      reconcileMemory: () => Promise.resolve(),
      reconcileTasks: () => Promise.resolve(),
    } as unknown as ReconcileService,
    model,
    { chatPromptFor: () => 'persona' } as unknown as PersonaService,
    { list: () => [] } as unknown as WorktreeService,
    { list: () => Promise.resolve([]) } as unknown as SessionRegistry,
    new MemorySaver() as unknown as PostgresSaver,
    { get: () => undefined } as unknown as EnvService,
  );
}

/** Drain a LangGraph stream without caring about the update values. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const item of stream) void item;
}

describe('bot graph — recursion guard', () => {
  it('(a) fires the break node on a confirmed loop: no llm call, pause message committed, cursor advanced', async () => {
    const channel = new FakeChannel();
    // Riley's bot message is the triggering turn (authorBotId set → guard evaluates)
    channel.append({
      id: 'b-1',
      author: 'Riley',
      authorId: 'riley',
      authorBotId: 'riley',
      text: 'sounds good as usual',
    });

    const invocations: BaseMessage[][] = [];
    const detectCalls: string[] = [];

    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (_bot: unknown, windowText: string) => {
        detectCalls.push(windowText);
        return Promise.resolve({
          looping: true,
          reasoning: 'same status repeated',
        });
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('should not reach here', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-loop:root' } };

    // Seed prior history to exceed the GUARD_FLOOR (6 AI messages minimum)
    await graph.updateState(config, {
      messages: priorAiHistory(6),
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    // Guard was invoked with a non-empty window
    expect(detectCalls).toHaveLength(1);
    expect(detectCalls[0]).toContain('prior response');

    // LLM was NOT called — the break node short-circuits before fetch/llm
    expect(invocations).toHaveLength(0);

    const final = await graph.getState(config);
    const { messages, cursor } = final.values as CheckpointValues;
    const lastMsg = messages[messages.length - 1];

    // The pause message is an AIMessage committed to the checkpoint
    expect(lastMsg.getType()).toBe('ai');
    expect(flat(lastMsg.content)).toContain(
      "I think I'm going in circles here",
    );

    // Cursor advanced past the triggering message (seq 0 → cursor 1)
    expect(cursor).toBe(1);
  });

  it('(b) proceeds to fetch and llm when the guard finds no loop', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'b-1',
      author: 'Riley',
      authorId: 'riley',
      authorBotId: 'riley',
      text: 'updated the design doc',
    });

    const invocations: BaseMessage[][] = [];

    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: () => Promise.resolve({ looping: false }),
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('looks good, thanks', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-ok:root' } };

    await graph.updateState(config, {
      messages: priorAiHistory(6),
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    // LLM WAS called — normal respond path
    expect(invocations).toHaveLength(1);

    const final = await graph.getState(config);
    const { messages } = final.values as CheckpointValues;
    const lastMsg = messages[messages.length - 1] as AIMessage;
    expect(flat(lastMsg.content)).toBe('looks good, thanks');
  });

  it('(c) skips guard detection when the triggering message is human-authored', async () => {
    const channel = new FakeChannel();
    // No authorBotId → human message
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'any thoughts on this?',
    });

    const invocations: BaseMessage[][] = [];
    const detectCalls: unknown[] = [];

    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (...args: unknown[]) => {
        detectCalls.push(args);
        return Promise.resolve({ looping: true }); // would wrongly break if called
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('here are my thoughts', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-human:root' } };

    // Seed enough history so detect WOULD fire if the skip were absent
    await graph.updateState(config, {
      messages: priorAiHistory(6),
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    // detect was NEVER called — human trigger bypasses the guard entirely
    expect(detectCalls).toHaveLength(0);
    // Normal llm path ran instead
    expect(invocations).toHaveLength(1);
  });

  it('(d) skips guard detection on a forced (job relay) turn', async () => {
    const channel = new FakeChannel();

    const invocations: BaseMessage[][] = [];
    const detectCalls: unknown[] = [];

    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (...args: unknown[]) => {
        detectCalls.push(args);
        return Promise.resolve({ looping: true }); // would wrongly break if called
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('session report handled', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-forced:root' } };

    // Forced turn: gate is bypassed (synthetic seed message), guard must also skip
    await drain(
      await graph.stream(
        {
          cursor: 0,
          forced: true,
          messages: [new HumanMessage('[Session s-1] reported back: done')],
        },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    // detect was NEVER called — forced turns skip the guard entirely
    expect(detectCalls).toHaveLength(0);
    // LLM ran normally (forced → respond path → no guard → fetch → llm)
    expect(invocations).toHaveLength(1);
  });
});
