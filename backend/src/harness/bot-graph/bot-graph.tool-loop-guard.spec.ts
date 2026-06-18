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
import type {
  ToolLoopDecision,
  ToolLoopGuardService,
  ToolLoopObservation,
} from '../recursion-guard/tool-loop-guard.service';
import type { SessionRegistry } from '../sessions/session-registry.port';
import type { ToolRegistry } from '../tools/tool.registry';
import type { WorkspaceReader } from '../workspaces/workspace-reader';
import { makeEmployee } from '@harness/employees/employee.testing';
import { BotGraphFactory } from './bot-graph.factory';

/**
 * `tool_loop_guard` node — catches a bot re-issuing the SAME tool call inside the `llm ⇄ tools`
 * loop. Deterministic prefilter (count identical tool+args this turn) gates a Haiku judge; a `stuck`
 * verdict corrects + refreshes once, then pauses if it persists. The guard service is faked so no
 * real LLM runs; the model is scripted to drive the loop.
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

/** A model scripted by a list of per-step replies: a tool call to `poke` with the given args, or
 * (when `args` is null) a final text reply that ends the turn. */
type Step = { args: Record<string, unknown> | null };

function scriptedModel(steps: Step[], invocations: BaseMessage[][]) {
  let i = 0;
  return {
    bindTools() {
      return this;
    },
    async invoke(convo: BaseMessage[]) {
      invocations.push(convo);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      if (step.args === null) return new AIMessage({ content: 'All done.' });
      return new AIMessage({
        content: '',
        tool_calls: [
          { name: 'poke', args: step.args, id: `call_${i}`, type: 'tool_call' },
        ],
      });
    },
  };
}

function buildFactory(
  channel: FakeChannel,
  model: ChatModelFactory,
  toolLoopGuard: ToolLoopGuardService,
): BotGraphFactory {
  const pokeTool = tool(async () => 'ran', {
    name: 'poke',
    description: 'no-op probe',
    schema: z.object({ n: z.number().optional() }),
  });
  return new BotGraphFactory(
    channel as unknown as ChannelService,
    { get: () => undefined } as unknown as ChannelRegistryService,
    {
      toStructuredTools: () => [pokeTool],
      // poke is untagged (no refresh scope) → the PASS path routes straight to llm.
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
    { buildModel: () => model } as unknown as ChatModelFactory,
    { chatPromptFor: () => 'persona' } as unknown as PersonaService,
    { list: () => [] } as unknown as WorkspaceReader,
    { list: async () => [] } as unknown as SessionRegistry,
    new MemorySaver() as unknown as PostgresSaver,
    { get: () => undefined } as unknown as EnvService,
    undefined, // engineTools
    undefined, // compactionStore
    toolLoopGuard, // toolLoopGuard
  );
}

/** A guard stub: enabled, threshold 3, returning a fixed verdict and recording every observation. */
function fakeGuard(
  verdict: () => 'progressing' | 'stuck',
  detectCalls: ToolLoopObservation[],
): ToolLoopGuardService {
  return {
    isEnabled: () => true,
    threshold: () => 3,
    detect: (_bot: unknown, obs: ToolLoopObservation) => {
      detectCalls.push(obs);
      return Promise.resolve({
        verdict: verdict(),
        reasoning: 'judge says so',
      } as ToolLoopDecision);
    },
  } as unknown as ToolLoopGuardService;
}

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

function seedHuman(channel: FakeChannel): void {
  channel.append({
    id: 'u-0',
    author: 'Dennis',
    authorId: 'dennis',
    text: 'Alex, do the thing.',
  });
}

describe('bot graph — tool-loop guard', () => {
  it('(a) below threshold: identical calls under the limit never invoke the Haiku judge', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    const invocations: BaseMessage[][] = [];
    const detectCalls: ToolLoopObservation[] = [];
    // Two identical poke calls (threshold is 3), then a final reply.
    const model = scriptedModel(
      [{ args: { n: 1 } }, { args: { n: 1 } }, { args: null }],
      invocations,
    );
    const factory = buildFactory(
      channel,
      model as unknown as ChatModelFactory,
      fakeGuard(() => 'stuck', detectCalls),
    );

    await runTurn(factory, 'alex:tlg-below:root');

    expect(detectCalls).toHaveLength(0); // prefilter never tripped
    expect(invocations).toHaveLength(3); // two tool steps + final reply
  });

  it('(b) at threshold + stuck: first trip corrects (instruction injected, corrections=1)', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    const invocations: BaseMessage[][] = [];
    const detectCalls: ToolLoopObservation[] = [];
    // Three identical calls trip the prefilter on the 3rd; after the correction the model stops.
    const model = scriptedModel(
      [
        { args: { n: 1 } },
        { args: { n: 1 } },
        { args: { n: 1 } },
        { args: null },
      ],
      invocations,
    );
    const factory = buildFactory(
      channel,
      model as unknown as ChatModelFactory,
      fakeGuard(() => 'stuck', detectCalls),
    );

    await runTurn(factory, 'alex:tlg-correct:root');

    // Judge fired once, on the 3rd identical call, with the observed signature.
    expect(detectCalls).toHaveLength(1);
    expect(detectCalls[0].toolName).toBe('poke');
    expect(detectCalls[0].results.length).toBe(3);

    // The post-correction llm call (step 4) carries the one-shot instruction as a transient message.
    expect(invocations).toHaveLength(4);
    const step4 = invocations[3].map((m) => flat(m.content)).join('\n');
    expect(step4).toContain('Stop re-issuing');
    expect(step4).toContain('poke');

    const graph = factory.getConductorGraph(ALEX);
    const final = await graph.getState({
      configurable: { thread_id: 'alex:tlg-correct:root' },
    });
    const values = final.values as {
      toolLoopCorrections: number;
      toolLoopInstruction?: string;
      messages: BaseMessage[];
    };
    expect(values.toolLoopCorrections).toBe(1);
    // The instruction is one-shot: cleared after the llm rendered it.
    expect(values.toolLoopInstruction).toBeUndefined();
    // The instruction NEVER entered durable history (so it's never committed to the channel).
    const persisted = values.messages.map((m) => flat(m.content)).join('\n');
    expect(persisted).not.toContain('Stop re-issuing');
  });

  it('(c) persists after a correction: escalates to a pause that ends the turn', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    const invocations: BaseMessage[][] = [];
    const detectCalls: ToolLoopObservation[] = [];
    // The model NEVER stops — keeps re-issuing the same call.
    const model = scriptedModel([{ args: { n: 1 } }], invocations);
    const factory = buildFactory(
      channel,
      model as unknown as ChatModelFactory,
      fakeGuard(() => 'stuck', detectCalls),
    );

    await runTurn(factory, 'alex:tlg-pause:root');

    // 3rd call → correct; 4th call → still stuck → pause. The model is invoked 4 times total.
    expect(invocations).toHaveLength(4);
    expect(detectCalls).toHaveLength(2);

    const graph = factory.getConductorGraph(ALEX);
    const final = await graph.getState({
      configurable: { thread_id: 'alex:tlg-pause:root' },
    });
    const { messages } = final.values as { messages: BaseMessage[] };
    const last = messages[messages.length - 1];
    expect(last.getType()).toBe('ai');
    expect(flat(last.content)).toContain("I think I'm going in circles here");
    expect(flat(last.content)).toContain(
      'What I kept repeating: judge says so',
    );
  });

  it('(d) at threshold + progressing: a legitimate poll loop is never interrupted', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    const invocations: BaseMessage[][] = [];
    const detectCalls: ToolLoopObservation[] = [];
    const model = scriptedModel(
      [
        { args: { n: 1 } },
        { args: { n: 1 } },
        { args: { n: 1 } },
        { args: null },
      ],
      invocations,
    );
    const factory = buildFactory(
      channel,
      model as unknown as ChatModelFactory,
      fakeGuard(() => 'progressing', detectCalls),
    );

    await runTurn(factory, 'alex:tlg-progressing:root');

    expect(detectCalls).toHaveLength(1); // judged once on the 3rd call…
    expect(invocations).toHaveLength(4); // …and allowed to continue to the final reply

    const graph = factory.getConductorGraph(ALEX);
    const final = await graph.getState({
      configurable: { thread_id: 'alex:tlg-progressing:root' },
    });
    const values = final.values as {
      toolLoopCorrections: number;
      messages: BaseMessage[];
    };
    expect(values.toolLoopCorrections).toBe(0); // never corrected
    const persisted = values.messages.map((m) => flat(m.content)).join('\n');
    expect(persisted).not.toContain('going in circles'); // never paused
  });

  it('(e) changing args never trip the prefilter (distinct signatures)', async () => {
    const channel = new FakeChannel();
    seedHuman(channel);
    const invocations: BaseMessage[][] = [];
    const detectCalls: ToolLoopObservation[] = [];
    // Same tool, DIFFERENT args each call → each signature count stays at 1.
    const model = scriptedModel(
      [
        { args: { n: 1 } },
        { args: { n: 2 } },
        { args: { n: 3 } },
        { args: null },
      ],
      invocations,
    );
    const factory = buildFactory(
      channel,
      model as unknown as ChatModelFactory,
      fakeGuard(() => 'stuck', detectCalls),
    );

    await runTurn(factory, 'alex:tlg-distinct:root');

    expect(detectCalls).toHaveLength(0); // distinct args → no loop detected
    expect(invocations).toHaveLength(4);
  });
});
