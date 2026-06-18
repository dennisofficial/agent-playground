import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { EnvService } from '@core/config/env/env.service';
import type { ChannelRegistryService } from '../channel/channel-registry.service';
import type { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { AddressingGate, GateDecision } from '../conductor/addressing-gate';
import { makeEmployee } from '@harness/employees/employee.testing';
import type { PersonaService } from '../employees/persona.service';
import type { ChatModelFactory } from '../llm/chat-model.factory';
import type { FetchService } from '../memory/fetch.service';
import type { ReconcileService } from '../memory/reconcile.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorkspaceService } from '../workspaces/workspace.service';
import { BotGraphFactory, type BotStateDelta } from './bot-graph.factory';

/**
 * THE IN-GRAPH ADDRESSING GATE. The gate moved from the conductor INTO the turn graph as its entry
 * node, so a skip lands in the same Langfuse trace as the turn it gated. This pins the node's
 * contract: respond → the normal turn (recall → llm …); skip → `consume` (advance the cursor PAST
 * the batch, no model call); `forced` (seeds) bypasses the classify. These two assertions are the
 * regressions that used to live in conductor.service.spec.ts before the gate ran in the conductor.
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

/** A fake AddressingGate that records every classify call's context and returns a scripted verdict. */
interface FakeGate {
  decide: (
    opts: { isDm: boolean; text: string; history: string },
    config?: RunnableConfig,
  ) => Promise<GateDecision>;
}

const makeFactory = (channel: FakeChannel, gate?: FakeGate): BotGraphFactory => {
  const fakeModel = {
    bindTools() {
      return this;
    },
    async invoke() {
      return new AIMessage({ content: 'On it.' });
    },
  };
  return new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined, isChannelKind: () => true } as unknown as ChannelRegistryService,
    {
      toStructuredTools: () => [],
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
    { list: () => [] } as unknown as WorkspaceService,
    { list: async () => [] } as unknown as SessionRegistry,
    new MemorySaver() as unknown as PostgresSaver,
    { get: () => undefined } as unknown as EnvService,
    undefined, // engineTools
    undefined, // compactionStore
    undefined, // toolLoopGuard
    gate as unknown as AddressingGate, // the in-graph gate
  );
};

/** Run one turn against the compiled graph, collecting the streamed deltas. */
const runTurn = async (
  factory: BotGraphFactory,
  thread: string,
  input: Record<string, unknown>,
): Promise<BotStateDelta[]> => {
  const stream = await factory.getConductorGraph(ALEX).stream(input, {
    configurable: { thread_id: thread },
    streamMode: 'updates' as const,
  });
  const deltas: BotStateDelta[] = [];
  for await (const update of stream as AsyncIterable<
    Record<string, BotStateDelta>
  >) {
    deltas.push(...Object.values(update));
  }
  return deltas;
};

const finalState = (factory: BotGraphFactory, thread: string) =>
  factory.getConductorGraph(ALEX).getState({ configurable: { thread_id: thread } });

const aiTexts = (deltas: BotStateDelta[]): string[] =>
  deltas
    .flatMap((d) => d.messages ?? [])
    .filter((m) => m.getType() === 'ai')
    .map((m) => flat(m.content));

describe('bot graph — in-graph addressing gate', () => {
  it('skip → consume advances the cursor PAST the batch (no busy-loop), no model call', async () => {
    // Regression (was conductor.service.spec): the skip path must land the cursor at lastSeq + 1, not
    // lastSeq — `since()` is inclusive, so lastSeq would leave the message in-window forever.
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Someone',
      authorId: 'someone',
      text: 'human-to-human chatter',
    });
    const gate: FakeGate = { decide: async () => 'skip' };
    const factory = makeFactory(channel, gate);
    const deltas = await runTurn(factory, 'alex:gate-skip:root', {
      cursor: 0,
      forced: false,
    });

    expect(aiTexts(deltas)).toEqual([]); // no model call on the skip path
    const final = await finalState(factory, 'alex:gate-skip:root');
    expect(final.values.decision).toBe('ignore');
    expect(final.values.cursor).toBe(1); // seq 0 + 1 — consumed PAST the batch
    expect(channel.since(final.values.cursor)).toHaveLength(0); // nothing left in-window
  });

  it("hands the gate Atlas's own recent messages so a reply to its own question is recognizable", async () => {
    // Regression (was conductor.service.spec): the gate context must INCLUDE Atlas's own messages, so
    // a bare "yes please" replying to Atlas's own question isn't a context-free aside → SKIP.
    const channel = new FakeChannel();
    channel.append({
      id: 'a-1',
      author: 'Alex',
      authorId: 'alex',
      authorBotId: 'alex',
      text: 'Want me to put together a backlog item?',
    });
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'yes please',
    });
    let seenHistory = '';
    const gate: FakeGate = {
      decide: async ({ history }) => {
        seenHistory = history;
        return 'respond';
      },
    };
    const factory = makeFactory(channel, gate);
    await runTurn(factory, 'alex:gate-history:root', { cursor: 0, forced: false });

    expect(seenHistory).toContain('Want me to put together a backlog item?');
    expect(seenHistory).toContain('yes please');
  });

  it('respond → runs the turn (recall → llm) and consumes to the high-water mark', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, status?',
    });
    const gate: FakeGate = { decide: async () => 'respond' };
    const factory = makeFactory(channel, gate);
    const deltas = await runTurn(factory, 'alex:gate-respond:root', {
      cursor: 0,
      forced: false,
    });

    expect(aiTexts(deltas)).toEqual(['On it.']);
    const final = await finalState(factory, 'alex:gate-respond:root');
    expect(final.values.decision).toBe('respond');
    expect(final.values.cursor).toBe(channel.lengthOf());
  });

  it('forced (seed) bypasses the gate — responds without a classify call', async () => {
    const channel = new FakeChannel();
    let decideCalls = 0;
    const gate: FakeGate = {
      decide: async () => {
        decideCalls++;
        return 'skip';
      },
    };
    const factory = makeFactory(channel, gate);
    const deltas = await runTurn(factory, 'alex:gate-forced:root', {
      cursor: 0,
      forced: true,
    });

    expect(decideCalls).toBe(0); // forced → no classify
    expect(aiTexts(deltas)).toEqual(['On it.']); // responded
  });

  it('does not inherit a prior seed turn’s forced flag — the next room turn still classifies', async () => {
    // Codex BLOCK: `forced` is persisted on the shared thread. A seed turn (forced:true) must not leak
    // into the next room turn — the conductor passes forced:false on non-seed turns, which the reducer
    // writes back. This pins that a forced turn followed by forced:false re-enters the classifier.
    const channel = new FakeChannel();
    let decideCalls = 0;
    const gate: FakeGate = {
      decide: async () => {
        decideCalls++;
        return 'skip';
      },
    };
    const factory = makeFactory(channel, gate);
    const thread = 'alex:gate-forced-leak:root';
    // Turn 1: a seed (forced) — bypasses the gate.
    await runTurn(factory, thread, { cursor: 0, forced: true });
    expect(decideCalls).toBe(0);
    // A human posts, then a normal room turn (forced:false) on the SAME thread.
    channel.append({
      id: 'u-0',
      author: 'Someone',
      authorId: 'someone',
      text: 'chatter',
    });
    await runTurn(factory, thread, { cursor: 0, forced: false });
    expect(decideCalls).toBe(1); // classified — forced did NOT leak from turn 1
    const final = await finalState(factory, thread);
    expect(final.values.decision).toBe('ignore');
  });
});
