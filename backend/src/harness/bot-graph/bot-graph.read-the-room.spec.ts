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
import {
  BotGraphFactory,
  type BotStateDelta,
  MAX_REVISION_PASSES,
  revisionNote,
} from './bot-graph.factory';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

/**
 * READ-THE-ROOM (optimistic-concurrency posting). A final text reply is composed blind for one
 * model-invoke latency; if a teammate-bot message lands in that window, the reply must be demoted
 * to a draft (never posted, never in durable history) and recomposed with the teammate's message
 * folded in. This spec pins that seam deterministically: the scripted model appends to the channel
 * DURING its own invoke — exactly the blind window.
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

interface FakeModel {
  bindTools(): FakeModel;
  invoke(convo: BaseMessage[]): Promise<AIMessage>;
}

const makeFactory = (
  channel: FakeChannel,
  fakeModel: FakeModel,
  tools: unknown[] = [],
): BotGraphFactory =>
  new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined } as unknown as ChannelRegistryService,
    {
      toStructuredTools: () => tools,
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
    { fetchMemory: async () => '', fetchTasks: async () => '' } as unknown as FetchService,
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

/** Drain a turn, collecting every streamed delta (what the conductor would see). */
const runTurn = async (
  factory: BotGraphFactory,
  thread: string,
): Promise<BotStateDelta[]> => {
  const graph = factory.getBotGraph(ALEX);
  const stream = await graph.stream(
    { cursor: 0, forced: false },
    { configurable: { thread_id: thread }, streamMode: 'updates' as const },
  );
  const deltas: BotStateDelta[] = [];
  for await (const update of stream as AsyncIterable<
    Record<string, BotStateDelta>
  >) {
    deltas.push(...Object.values(update));
  }
  return deltas;
};

const aiTexts = (deltas: BotStateDelta[]): string[] =>
  deltas
    .flatMap((d) => d.messages ?? [])
    .filter((m) => m.getType() === 'ai')
    .map((m) => flat(m.content));

describe('bot graph — read-the-room (post-seam freshness check)', () => {
  it('quiet channel during compose → posts unchanged, no revision', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, status?',
    });
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        return new AIMessage({ content: 'Working on the cost footer.' });
      },
    };
    const factory = makeFactory(channel, fakeModel);
    const deltas = await runTurn(factory, 'alex:rtr-quiet:root');

    expect(invocations).toHaveLength(1);
    expect(aiTexts(deltas)).toEqual(['Working on the cost footer.']);
    const final = await factory
      .getBotGraph(ALEX)
      .getState({ configurable: { thread_id: 'alex:rtr-quiet:root' } });
    expect(final.values.draft).toBeUndefined();
    expect(final.values.revisionPasses).toBe(0);
    expect(final.values.cursor).toBe(channel.lengthOf());
  });

  it('teammate posts during compose → draft suppressed, revision sees the message + note, empty output stays silent', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'What are you all working on?',
    });
    const DRAFT = 'Riley shipped the admin panel and I did the footer.';
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        if (invocations.length === 1) {
          // Lands DURING this compose — the blind window.
          channel.append({
            id: 'riley:0',
            author: 'Riley',
            authorId: 'riley',
            authorBotId: 'riley',
            text: 'I shipped the admin panel revamp today.',
          });
          return new AIMessage({ content: DRAFT });
        }
        return new AIMessage({ content: '' }); // revision verdict: redundant → silent
      },
    };
    const factory = makeFactory(channel, fakeModel);
    const deltas = await runTurn(factory, 'alex:rtr-stale:root');

    expect(invocations).toHaveLength(2);
    // The revision pass sees BOTH: Riley's message (normal fold-in) and the draft note.
    const revisionInput = invocations[1]
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));
    expect(
      revisionInput.some((t) => t.includes('Riley: I shipped the admin panel')),
    ).toBe(true);
    expect(revisionInput.some((t) => t === revisionNote(DRAFT))).toBe(true);

    // The draft never posts: not in any streamed delta's messages, only on the draft field.
    expect(aiTexts(deltas).some((t) => t.includes(DRAFT))).toBe(false);
    expect(deltas.some((d) => d.draft === DRAFT)).toBe(true);

    // …and never in durable history; Riley's message is in history exactly once.
    const final = await factory
      .getBotGraph(ALEX)
      .getState({ configurable: { thread_id: 'alex:rtr-stale:root' } });
    const history = (final.values.messages as BaseMessage[]).map((m) =>
      flat(m.content),
    );
    expect(history.some((t) => t.includes(DRAFT))).toBe(false);
    expect(
      history.filter((t) => t.includes('Riley: I shipped the admin panel')),
    ).toHaveLength(1);
    expect(final.values.draft).toBeUndefined(); // resolved by the revision pass
    expect(final.values.cursor).toBe(channel.lengthOf()); // Riley's message consumed
  });

  it('contention on every pass → capped at MAX_REVISION_PASSES, then posts anyway', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Status?',
    });
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        const n = invocations.length;
        channel.append({
          id: `riley:${n}`,
          author: 'Riley',
          authorId: 'riley',
          authorBotId: 'riley',
          text: `teammate update ${n}`,
        });
        return new AIMessage({ content: `answer v${n}` });
      },
    };
    const factory = makeFactory(channel, fakeModel);
    const deltas = await runTurn(factory, 'alex:rtr-cap:root');

    // 1 original + MAX_REVISION_PASSES revisions; the last posts despite fresh contention.
    expect(invocations).toHaveLength(1 + MAX_REVISION_PASSES);
    expect(aiTexts(deltas)).toEqual([`answer v${1 + MAX_REVISION_PASSES}`]);
    const final = await factory
      .getBotGraph(ALEX)
      .getState({ configurable: { thread_id: 'alex:rtr-cap:root' } });
    expect(final.values.draft).toBeUndefined();
    expect(final.values.revisionPasses).toBe(MAX_REVISION_PASSES);
    // The message that landed during the LAST invoke stays unconsumed — next turn's gate handles it.
    expect(final.values.cursor).toBe(channel.lengthOf() - 1);
  });

  it('tool-call steps are never gated — interleave folds into the post-tools step instead', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, check the worktree.',
    });
    const poke = tool(async () => 'poked', {
      name: 'poke',
      description: 'probe',
      schema: z.object({}),
    });
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        if (invocations.length === 1) {
          channel.append({
            id: 'riley:0',
            author: 'Riley',
            authorId: 'riley',
            authorBotId: 'riley',
            text: 'meanwhile, a teammate message',
          });
          // Narration text + a tool call: must enter history INTACT (tool_use needs its result).
          return new AIMessage({
            content: 'Checking the worktree…',
            tool_calls: [
              { name: 'poke', args: {}, id: 'call_1', type: 'tool_call' },
            ],
          });
        }
        return new AIMessage({ content: 'All good.' });
      },
    };
    const factory = makeFactory(channel, fakeModel, [poke]);
    const deltas = await runTurn(factory, 'alex:rtr-tools:root');

    // No suppression anywhere: the tool-call step posts its narration, and the teammate message
    // reaches step 2 through the NORMAL mid-thought fold-in, not a revision note.
    expect(deltas.some((d) => d.draft)).toBe(false);
    expect(aiTexts(deltas)).toEqual(['Checking the worktree…', 'All good.']);
    const step2 = invocations[1]
      .filter((m) => m.getType() === 'human')
      .map((m) => flat(m.content));
    expect(
      step2.some((t) => t.includes('Riley: meanwhile, a teammate message')),
    ).toBe(true);
    expect(step2.some((t) => t.includes('NOT posted'))).toBe(false);
  });

  it('a HUMAN message landing mid-compose does not trigger a revision', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, quick status?',
    });
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        channel.append({
          id: 'u-1',
          author: 'Dennis',
          authorId: 'dennis',
          text: 'also, one more thing…',
        });
        return new AIMessage({ content: 'Footer work is done.' });
      },
    };
    const factory = makeFactory(channel, fakeModel);
    const deltas = await runTurn(factory, 'alex:rtr-human:root');

    expect(invocations).toHaveLength(1);
    expect(aiTexts(deltas)).toEqual(['Footer work is done.']);
    const final = await factory
      .getBotGraph(ALEX)
      .getState({ configurable: { thread_id: 'alex:rtr-human:root' } });
    // The human's mid-compose message stays unconsumed — the next turn GATES it normally.
    expect(final.values.cursor).toBe(channel.lengthOf() - 1);
  });

  it('the next turn’s gate resets draft state (no replay of an orphaned draft)', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Status?',
    });
    const invocations: BaseMessage[][] = [];
    const fakeModel: FakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo) {
        invocations.push(convo);
        const n = invocations.length;
        channel.append({
          id: `riley:${n}`,
          author: 'Riley',
          authorId: 'riley',
          authorBotId: 'riley',
          text: `update ${n}`,
        });
        return new AIMessage({ content: `answer v${n}` });
      },
    };
    const factory = makeFactory(channel, fakeModel);
    await runTurn(factory, 'alex:rtr-reset:root');
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:rtr-reset:root' } };
    expect((await graph.getState(config)).values.revisionPasses).toBe(
      MAX_REVISION_PASSES,
    );

    // Second turn — even an empty/ignore turn passes through `gate`, which resets the counters.
    const stream = await graph.stream(
      { cursor: channel.lengthOf(), forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }
    const after = await graph.getState(config);
    expect(after.values.revisionPasses).toBe(0);
    expect(after.values.draft).toBeUndefined();
  });
});
