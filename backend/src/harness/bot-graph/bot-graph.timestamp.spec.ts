import {
  AIMessage,
  type BaseMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
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
import { BotGraphFactory } from './bot-graph.factory';
import { makeEmployee } from '@harness/employees/employee.testing';

/**
 * Pins the time-context injection contract:
 *  1. The model always receives a "Current time: …" volatile HumanMessage.
 *  2. That string NEVER appears in the SystemMessage (which is cached and must be byte-stable).
 *  3. When the gap between prior history and the fresh batch exceeds the threshold, a
 *     time-divider HumanMessage is woven into the fresh batch's model-view.
 */

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

class FakeChannel {
  readonly surfaceId = 'tui:test';
  readonly msgs: ChannelMsg[] = [];
  private nextSeq = 0;

  append(
    msg: Omit<ChannelMsg, 'seq' | 'channelId' | 'createdAt'> & {
      channelId?: string;
      createdAt?: number; // allow test-controlled stamps in this spec only
    },
  ): ChannelMsg {
    const full: ChannelMsg = {
      ...msg,
      channelId: msg.channelId ?? this.surfaceId,
      seq: this.nextSeq++,
      createdAt: msg.createdAt ?? Date.now(),
    };
    this.msgs.push(full);
    return full;
  }
  since(cursor: number): ChannelMsg[] {
    return this.msgs.filter((m) => m.seq >= cursor);
  }
  lengthOf(): number {
    return this.nextSeq;
  }
  snapshot(): ChannelMsg[] {
    return [...this.msgs];
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

const PERSONA_TEXT = 'you are alex, the backend bot';

function buildFactory(channel: FakeChannel, gapMs?: number) {
  const invocations: BaseMessage[][] = [];
  const fakeModel = {
    bindTools() {
      return this;
    },
    async invoke(convo: BaseMessage[]) {
      invocations.push(convo);
      return new AIMessage({ content: 'done' });
    },
  };

  const factory = new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined } as unknown as ChannelRegistryService,
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
    { chatPromptFor: () => PERSONA_TEXT } as unknown as PersonaService,
    { list: () => [] } as unknown as WorktreeService,
    { list: async () => [] } as unknown as SessionRegistry,
    new MemorySaver() as unknown as PostgresSaver,
    { get: () => gapMs } as unknown as EnvService,
  );

  return { factory, invocations };
}

describe('bot graph — time context injection', () => {
  it('includes a "Current time:" HumanMessage in the volatile block on every llm step', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'hey',
    });
    const { factory, invocations } = buildFactory(channel);
    const graph = factory.getConductorGraph(ALEX);
    await graph.invoke(
      { cursor: 0, forced: false },
      { configurable: { thread_id: 'alex:ts-test:root' } },
    );

    expect(invocations).toHaveLength(1);
    const convo = invocations[0];

    // Cache-safety guard: the SystemMessage must be byte-identical to the persona text,
    // i.e. it must NOT contain "Current time:".
    const sysMsg = convo.find((m) => m instanceof SystemMessage)!;
    expect(sysMsg).toBeDefined();
    const sysText = flat(sysMsg.content);
    expect(sysText).toContain(PERSONA_TEXT);
    expect(sysText).not.toContain('Current time:');

    // The volatile HumanMessage block MUST carry the current-time line.
    const humanMsgs = convo.filter((m) => m.getType() === 'human');
    const timeMsg = humanMsgs.find((m) =>
      flat(m.content).includes('Current time:'),
    );
    expect(timeMsg).toBeDefined();
  });

  it('injects a time-divider HumanMessage between fresh messages separated by a large gap', async () => {
    const channel = new FakeChannel();
    const HOUR = 3_600_000;
    const now = Date.now();

    // A "consumed" message already in history — set an old timestamp.
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'first message',
      createdAt: now - 5 * HOUR,
    });

    // Two fresh messages with a 2h gap between them (both > cursor=0 so they're fresh).
    // For this test we advance the cursor manually via a prior "consume" run.
    const { factory, invocations } = buildFactory(channel, HOUR);
    const graph = factory.getConductorGraph(ALEX);
    const cfg = { configurable: { thread_id: 'alex:ts-div:root' } };

    // Turn 1: bot responds to u-0 (cursor starts at 0). Advance cursor to 1.
    await graph.invoke({ cursor: 0, forced: false }, cfg);
    invocations.length = 0; // clear to isolate turn 2

    // Now add two fresh messages with a 2h gap between them.
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'back after a while',
      createdAt: now - 2 * HOUR,
    });
    channel.append({
      id: 'u-2',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'and another one',
      createdAt: now, // 2h after u-1 — above the 1h threshold
    });

    // Turn 2: cursor=1 (from state after turn 1), bot sees u-1 and u-2.
    await graph.invoke({ cursor: 1, forced: false }, cfg);

    expect(invocations).toHaveLength(1);
    const convo = invocations[0];
    const humanTexts = convo
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));

    // The time-divider label should appear in one of the HumanMessages with the exact gap text.
    const hasDivider = humanTexts.some((t) => t.includes('——— 2 hours later'));
    expect(hasDivider).toBe(true);

    // The actual message content is still present (plain Author: text form).
    const hasFirstMsg = humanTexts.some((t) =>
      t.includes('Dennis: back after a while'),
    );
    const hasSecondMsg = humanTexts.some((t) =>
      t.includes('Dennis: and another one'),
    );
    expect(hasFirstMsg).toBe(true);
    expect(hasSecondMsg).toBe(true);
  });

  it('does NOT contaminate state.messages (durable checkpoint) with time-divider entries', async () => {
    const channel = new FakeChannel();
    const HOUR = 3_600_000;
    const now = Date.now();

    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'hey',
      createdAt: now - 4 * HOUR,
    });
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'anyone here?',
      createdAt: now,
    });

    const { factory } = buildFactory(channel, HOUR);
    const graph = factory.getConductorGraph(ALEX);
    const cfg = { configurable: { thread_id: 'alex:ts-persist:root' } };
    await graph.invoke({ cursor: 0, forced: false }, cfg);

    const finalState = await graph.getState(cfg);
    const persistedHuman = (finalState.values.messages as BaseMessage[])
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));

    // Divider labels must NOT be in the durable checkpoint — only real "Author: text" entries.
    expect(persistedHuman.every((t) => !t.includes('———'))).toBe(true);
    expect(persistedHuman.every((t) => !t.includes('Current time:'))).toBe(
      true,
    );
    expect(persistedHuman).toEqual(['Dennis: hey', 'Dennis: anyone here?']);
  });
});
