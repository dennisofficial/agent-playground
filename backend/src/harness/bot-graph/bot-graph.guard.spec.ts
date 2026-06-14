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
import { makeEmployee } from '@harness/employees/employee.testing';

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

/** Seed N AI messages (prior turns) to satisfy the guard's GUARD_FLOOR minimum. */
const priorAiHistory = (n: number): AIMessage[] =>
  Array.from(
    { length: n },
    (_, i) => new AIMessage({ content: `prior response ${i + 1}` }),
  );

/**
 * Seed N tool-only AI messages (empty content + a tool call) — the shape of a silent turn where
 * the gate passed but the employee just used a tool and ended its turn. These post no chat text
 * and must never count as loop evidence.
 */
const toolOnlyHistory = (n: number): AIMessage[] =>
  Array.from(
    { length: n },
    (_, i) =>
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'list_sessions', args: {}, id: `t${i}` }],
      }),
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
      refreshScopesByName: () => new Map(),
    } as unknown as ToolRegistry,
    {
      gate: () => Promise.resolve({ action: 'respond' as const }),
    } as unknown as GateService,
    guard,
    {
      fetchMemory: () => Promise.resolve(''),
      fetchTasks: () => Promise.resolve(''),
    } as unknown as FetchService,
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

    // The pause message is an AIMessage committed to the checkpoint, carrying the judge's
    // diagnosis so the bot can see WHAT it was repeating
    expect(lastMsg.getType()).toBe('ai');
    expect(flat(lastMsg.content)).toContain(
      "I think I'm going in circles here",
    );
    expect(flat(lastMsg.content)).toContain(
      'What I kept repeating: same status repeated',
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

  it('(e) skips guard detection when a human spoke ANYWHERE in the batch, even with a bot-latest trigger', async () => {
    const channel = new FakeChannel();
    // Dennis pings, then a fast teammate's reply lands LAST in the batch — the old "latest only"
    // check would have run the guard here and eaten Dennis's answer with a pause.
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: '@Alex are you back?',
    });
    channel.append({
      id: 'b-1',
      author: 'Riley',
      authorId: 'riley',
      authorBotId: 'riley',
      text: 'welcome back alex',
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
      scriptedModel('yes — back and unblocked', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = {
      configurable: { thread_id: 'alex:guard-batch-human:root' },
    };
    await graph.updateState(config, { messages: priorAiHistory(8), cursor: 0 });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(0); // human in batch → real turn, no fuse check
    expect(invocations).toHaveLength(1);
  });

  it('(f) once paused, bot-only chatter never re-fires the guard (re-arms only after a substantive reply)', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'b-1',
      author: 'Riley',
      authorId: 'riley',
      authorBotId: 'riley',
      text: 'still working through the backlog',
    });

    const invocations: BaseMessage[][] = [];
    const detectCalls: unknown[] = [];
    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (...args: unknown[]) => {
        detectCalls.push(args);
        return Promise.resolve({ looping: true });
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('normal reply', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-paused:root' } };
    // History ends on a prior pause — the guard must NOT evaluate again on bot-only input.
    await graph.updateState(config, {
      messages: [
        ...priorAiHistory(8),
        new AIMessage({
          content:
            "I think I'm going in circles here — pausing so I don't spin. Ping me when you want me to pick this back up.",
        }),
      ],
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(0); // sentinel-last → guard stays quiet
    expect(invocations).toHaveLength(1); // the turn itself still runs normally
  });

  it('(g) prior pause lines are EXCLUDED from the judged window — the breaker never feeds itself', async () => {
    const channel = new FakeChannel();
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
        return Promise.resolve({ looping: false });
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('proceeding', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-window:root' } };
    // History: substantive turns, two old pauses in the middle, then a fresh substantive reply
    // (so the sentinel-last skip doesn't apply and the guard evaluates).
    await graph.updateState(config, {
      messages: [
        ...priorAiHistory(6),
        new AIMessage({
          content:
            "I think I'm going in circles here — pausing so I don't spin.",
        }),
        new AIMessage({
          content:
            "I think I'm going in circles here — pausing so I don't spin.",
        }),
        new AIMessage({ content: 'back to it — picked up the ticket again' }),
      ],
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(1);
    expect(detectCalls[0]).not.toContain('going in circles'); // pauses are not loop evidence
    expect(detectCalls[0]).toContain('picked up the ticket again');
  });

  it('(h) a CHECKPOINTED loopBreak=true from a prior turn never re-breaks — skips overwrite, not preserve', async () => {
    const channel = new FakeChannel();
    // The exact live failure: a prior turn broke (loopBreak: true persisted in the checkpoint),
    // then Dennis pings directly. The skip must CLEAR the stale flag, not leave it routing to
    // break with an hour-old verdict.
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: '@Alex are you back now?',
    });

    const invocations: BaseMessage[][] = [];
    const detectCalls: unknown[] = [];
    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (...args: unknown[]) => {
        detectCalls.push(args);
        return Promise.resolve({ looping: true });
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('yes — back now, picking the ticket up', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = {
      configurable: { thread_id: 'alex:guard-stale-break:root' },
    };
    // Seed the poisoned checkpoint: pause-last history AND a persisted loopBreak verdict.
    await graph.updateState(config, {
      messages: [
        ...priorAiHistory(8),
        new AIMessage({
          content:
            "I think I'm going in circles here — pausing so I don't spin. Ping me when you want me to pick this back up.",
        }),
      ],
      cursor: 0,
      loopBreak: true,
      guardReasoning: 'an hour-old verdict',
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(0); // human trigger → no judging
    expect(invocations).toHaveLength(1); // and a REAL turn ran — the stale break did not re-fire

    const final = await graph.getState(config);
    const { messages, loopBreak } = final.values as CheckpointValues & {
      loopBreak?: boolean;
    };
    const lastMsg = messages[messages.length - 1];
    expect(flat(lastMsg.content)).toBe('yes — back now, picking the ticket up');
    expect(loopBreak).toBe(false); // the stale flag was cleared, not preserved
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

  it('(i) silent tool-only turns are never loop evidence — gate-passed end_turn declines do not pause', async () => {
    const channel = new FakeChannel();
    channel.append({
      id: 'b-1',
      author: 'Riley',
      authorId: 'riley',
      authorBotId: 'riley',
      text: 'pushing the deploy now',
    });

    const invocations: BaseMessage[][] = [];
    const detectCalls: unknown[] = [];
    const guard = {
      isEnabled: () => true,
      windowSize: () => 12,
      detect: (...args: unknown[]) => {
        detectCalls.push(args);
        return Promise.resolve({ looping: true }); // would wrongly break if reached
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('normal reply', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-silent:root' } };

    // History is ALL tool-only turns: the bot kept passing the gate, checking sessions, and
    // ending its turn silently. There are 8 such AI messages — well past GUARD_FLOOR by count —
    // but none of them is spoken, so the guard must never run.
    await graph.updateState(config, {
      messages: toolOnlyHistory(8),
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(0); // no spoken messages → floor not met → no judging
    expect(invocations).toHaveLength(1); // and a normal turn ran instead of a pause
  });

  it('(j) mixed history feeds only SPOKEN messages to the judge — silent tool turns are excluded', async () => {
    const channel = new FakeChannel();
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
        return Promise.resolve({ looping: false });
      },
    } as unknown as RecursionGuardService;

    const factory = buildFactory(
      channel,
      guard,
      scriptedModel('proceeding', invocations),
    );
    const graph = factory.getBotGraph(ALEX);
    const config = { configurable: { thread_id: 'alex:guard-mixed:root' } };

    // 6 spoken turns interleaved with silent tool-only turns. The silent turns must not appear
    // in the judged window, even though they sit between the spoken lines.
    await graph.updateState(config, {
      messages: priorAiHistory(6).flatMap((m) => [m, ...toolOnlyHistory(1)]),
      cursor: 0,
    });

    await drain(
      await graph.stream(
        { cursor: 0, forced: false },
        { ...config, streamMode: 'updates' as const },
      ),
    );

    expect(detectCalls).toHaveLength(1);
    // Spoken lines are present…
    expect(detectCalls[0]).toContain('prior response 1');
    expect(detectCalls[0]).toContain('prior response 6');
    // …and the empty-text tool-only lines are not.
    expect(detectCalls[0]).not.toContain('[tools: list_sessions]');
    expect(detectCalls[0]).not.toMatch(/^Alex:\s*\[tools:/m);
  });
});
