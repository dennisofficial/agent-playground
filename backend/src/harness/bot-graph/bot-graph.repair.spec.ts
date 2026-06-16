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
    const config = {
      configurable: { thread_id: 'alex:orphan-tool-result:root' },
    };

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
      // `summary` (old single-string field) is gone; `summaries` defaults to [].
      // A legacy checkpoint (summarizedUpTo > 0, summaries = []) is self-healed at read
      // time: llmNode treats it as uncompacted and shows the full history — so the
      // "orphan" ToolMessage[2] is not orphaned when the full history is used (its owner
      // AIMessage[1] is still present). filterToolDispatchMessages then removes both
      // AIMessage[1] (empty dispatch) and ToolMessage[2] from the model input.
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

  it('legacy checkpoint: `summary` string is shown in model input and verbatim tail is used (not full history)', async () => {
    /**
     * Migration regression: a pre-TKT-38 checkpoint carries `summary: string` + `summarizedUpTo > 0`
     * but `summaries = []`. Without the compat shim, llmNode would treat it as uncompacted, replay
     * the full durable history (potentially blowing the context window), and ignore the saved summary.
     *
     * With the shim, `effectiveSummaries = [state.summary]` so:
     *   1. The summary block is injected as a HumanMessage before the verbatim tail.
     *   2. The model only receives messages from `summarizedUpTo` onward (not from 0).
     *
     * Setup:
     *   messages[0]: HumanMessage  ← compacted (before summarizedUpTo=2)
     *   messages[1]: AIMessage     ← compacted (before summarizedUpTo=2)
     *   messages[2]: HumanMessage  ← verbatim tail starts here
     *   messages[3]: AIMessage     ← verbatim tail
     *
     * summary = 'LEGACY_SUMMARY: Dennis asked about status; Alex said all is on track.'
     * summarizedUpTo = 2 (tail starts at idx 2)
     */
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Any updates?',
    });

    const invocations: BaseMessage[][] = [];
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(convo: BaseMessage[]) {
        invocations.push(convo);
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
    const config = {
      configurable: { thread_id: 'alex:legacy-summary-compat:root' },
    };

    const LEGACY_SUMMARY =
      'LEGACY_SUMMARY: Dennis asked about status; Alex said all is on track.';

    // Seed a pre-TKT-38 checkpoint: old-style `summary` string + summarizedUpTo, no `summaries`.
    await graph.updateState(config, {
      messages: [
        new HumanMessage('Dennis: what is the project status?'), // idx 0 — compacted
        new AIMessage({ content: 'All is on track.' }), // idx 1 — compacted
        new HumanMessage('Dennis: great, keep going.'), // idx 2 — verbatim tail start
        new AIMessage({ content: 'Will do.' }), // idx 3 — verbatim tail
      ],
      summary: LEGACY_SUMMARY, // pre-TKT-38 field
      summarizedUpTo: 2, // tail starts at idx 2
      // summaries intentionally absent → defaults to []
      cursor: 1,
    });

    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Any final updates?',
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

    // 1. The legacy summary MUST appear as a HumanMessage in the model input.
    const summaryMsg = convo.find(
      (m) =>
        m.getType() === 'human' && String(m.content).includes(LEGACY_SUMMARY),
    );
    expect(summaryMsg).toBeDefined();

    // 2. The compacted messages (idx 0–1) must NOT appear in the model input.
    //    "what is the project status?" is unique to the compacted region.
    const compactedLeaked = convo.find(
      (m) =>
        m.getType() === 'human' &&
        String(m.content).includes('what is the project status?'),
    );
    expect(compactedLeaked).toBeUndefined();

    // 3. The verbatim tail message (idx 2) MUST appear.
    const tailMsg = convo.find(
      (m) =>
        m.getType() === 'human' &&
        String(m.content).includes('great, keep going.'),
    );
    expect(tailMsg).toBeDefined();

    // Turn completed.
    const final = await graph.getState(config);
    expect(final.values.cursor).toBe(2);
  });

  it('persists a pair-safe summarizedUpTo that always lands on a HumanMessage (write-path)', async () => {
    /**
     * Three-block compaction write-path test.
     *
     * Verifies that `findCompactionCutPoint` (token-budget walk-back) plus `pairSafeBoundary`
     * always persist a `summarizedUpTo` that points at a HumanMessage, never a ToolMessage or
     * AIMessage, and that `summaries[]` is populated correctly.
     *
     * Token budget design (VERBATIM_BUFFER_TOKENS = 10 000, COMPACTION_TRIGGER_TOKENS = 20 000,
     * token estimate = ceil(chars / 4)):
     *
     *   After the turn there are 25 messages (23 seeded + 1 Human channel + 1 AI reply):
     *
     *   idx 0–3 : HumanMessages, each 10 000 chars (2 500 est. tokens each → 10 000 total)
     *   idx 4   : HumanMessage, ~34 chars (~9 tokens)   ← target HumanMessage boundary
     *   idx 5   : AIMessage(tool_call 'tc-write-01'), content='' + tool JSON (~25 tokens)
     *   idx 6   : ToolMessage('tc-write-01'), short (~5 tokens)
     *   idx 7   : AIMessage reply, short (~8 tokens)
     *   idx 8–22: 15 padding Human/AI messages, each 2 656 chars (664 tokens each = 9 960 total)
     *   idx 23  : HumanMessage "Any updates?" (~3 tokens) — added by channel this turn
     *   idx 24  : AIMessage "Status looks good." (~5 tokens) — added by llmNode this turn
     *
     *   Total est. tokens ≈ 10 000 (idx 0–3) + 9 + 25 + 5 + 8 + 9 960 + 3 + 5 = ~20 015
     *   → triggers COMPACTION_TRIGGER_TOKENS = 20 000 ✓
     *
     *   verbatim walk-back from end:
     *     acc accumulates idx 24→8: ~9 976 tokens (fits in 10 000 budget), cut=8
     *     idx 7 (AI, 8): acc=9 984, cut=7
     *     idx 6 (Tool, 5): acc=9 989, cut=6
     *     idx 5 (AI+tool, 25): acc+25=10 014 > 10 000, i<24 → BREAK, cut stays 6
     *   raw cut = 6 (ToolMessage)
     *   pairSafeBoundary(messages, 6, 0):
     *     (a) messages[6] is tool → walk back to b=5 (AI owner)
     *     (b) ownership: AI[5].tool_calls covers ToolMessage[6].tool_call_id ✓
     *     (c) Human boundary: b=5 is AI → b=4 (HumanMessage) → return 4
     *   summarizedUpTo = 4 ✓
     *
     *   NOTE: 25 − 20 = 5 was the OLD arithmetic cut; the new token-budget cut (6) is > 5,
     *   and the final value (4) is still < 5, so the assertion < msgs.length − 20 still holds.
     */
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, project status?',
    }); // seq=0 — drives cursor seeding below

    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(_convo: BaseMessage[]) {
        callCount++;
        if (callCount === 1) {
          // llmNode: return a plain AI reply — token estimation, not usage_metadata, triggers compaction.
          return new AIMessage({ content: 'Status looks good.' });
        }
        // compactionNode's summarisation call.
        return new AIMessage({
          content:
            'Rolling summary: Dennis requested project status; Alex confirmed all is on track.',
        });
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
    const config = {
      configurable: { thread_id: 'alex:compaction-write:root' },
    };

    // Build 23 seeded messages (see budget design in the docblock above).
    //   idx 0–3 : large HumanMessages (10 000 chars each) — pushed before the verbatim window
    //   idx 4   : HumanMessage — the Human boundary pairSafeBoundary lands on
    //   idx 5   : AIMessage(tool_call tc-write-01) — raw budget cut lands here → pair-safety fires
    //   idx 6   : ToolMessage(tc-write-01) — ToolMessage walk-back in pairSafeBoundary step (a)
    //   idx 7   : AIMessage — reply after the tool block
    //   idx 8–22: padding (each 2 656 chars = 664 est. tokens), fills up the verbatim buffer
    const LARGE = 'x'.repeat(10_000); // 10 000 chars → 2 500 est. tokens per message
    const PAD = 'p'.repeat(2_656); // 2 656 chars → 664 est. tokens per message
    const tc = 'tc-write-01';
    const seededMessages: BaseMessage[] = [
      new HumanMessage(LARGE),
      new HumanMessage(LARGE),
      new HumanMessage(LARGE),
      new HumanMessage(LARGE),
      new HumanMessage('Dennis: thanks, one more question'),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            name: 'recall',
            args: { query: 'status' },
            id: tc,
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: tc,
        name: 'recall',
        content: 'Project is on track.',
      }),
      new AIMessage({ content: 'Based on recall: all is on track.' }),
    ];
    // Padding: indices 8–22 (15 messages, alternating Human/AI), each 2 656 chars.
    for (let i = 8; i < 23; i++) {
      seededMessages.push(
        i % 2 === 0 ? new HumanMessage(PAD) : new AIMessage({ content: PAD }),
      );
    }
    // (sanity) 8 + 15 = 23 seeded messages
    expect(seededMessages).toHaveLength(23);

    await graph.updateState(config, {
      messages: seededMessages,
      cursor: 1, // state has consumed seq=0 (u-0); next turn picks up seq≥1
    });

    // Trigger a turn: new channel message (seq=1) → llmNode adds [Human(23), AI(24)] →
    // compactionNode: est. total tokens > 20 000, raw cut = 6 (ToolMessage),
    // pairSafeBoundary walks to Human(4).
    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Any updates?',
    }); // seq=1
    const stream = await graph.stream(
      { cursor: 1, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    // -- Invariant-based assertions on the persisted checkpoint --
    const final = await graph.getState(config);
    const msgs = final.values.messages as BaseMessage[];
    const summarizedUpTo = final.values.summarizedUpTo as number;

    // The boundary must have landed on a HumanMessage — the Human-boundary guarantee.
    // Raw cut was 6 (ToolMessage); pairSafeBoundary stepped back to AI(5), then to Human(4).
    expect(msgs[summarizedUpTo].getType()).toBe('human');

    // The final cut (4) is strictly below the OLD arithmetic cut (25 − 20 = 5), confirming
    // pairSafeBoundary added value beyond the raw budget calculation.
    expect(summarizedUpTo).toBeLessThan(msgs.length - 20);

    // The verbatim tail must NOT start with a tool_result.
    expect(msgs.slice(summarizedUpTo)[0].getType()).not.toBe('tool');

    // Compaction fired for the first time on this thread.
    expect(final.values.compactionVersion).toBe(1);

    // `summaries` queue has exactly one entry and it is non-empty.
    const summaries = final.values.summaries as string[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBeTruthy();
  });

  it('does not compact when block 3 is at exactly COMPACTION_TRIGGER_TOKENS (boundary)', async () => {
    /**
     * Boundary regression: compaction fires only when tailTokens > COMPACTION_TRIGGER_TOKENS
     * (strictly greater than), NOT at exactly 20 000. The guard is `tailTokens <= threshold → {}`.
     *
     * Token budget (token = ceil(chars / 4)):
     *   Seeded : HumanMessage('x' × 79 960) → ceil(79960/4) = 19 990 tokens
     *   Turn adds:
     *     HumanMessage("Dennis: Any updates?") = 20 chars → 5 tokens  (via asInput)
     *     AIMessage("Status looks good.")       = 18 chars → 5 tokens
     *   Total at compactionNode: 19 990 + 5 + 5 = 20 000 tokens (exactly COMPACTION_TRIGGER_TOKENS)
     *   → 20 000 ≤ 20 000 → compactionNode returns {} immediately; no LLM compaction call.
     */
    const channel = new FakeChannel();
    channel.append({
      id: 'u-0',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Alex, project status?',
    });

    let callCount = 0;
    const fakeModel = {
      bindTools() {
        return this;
      },
      async invoke(_convo: BaseMessage[]) {
        callCount++;
        return new AIMessage({ content: 'Status looks good.' }); // 18 chars → 5 tokens
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
    const config = {
      configurable: { thread_id: 'alex:boundary-no-compact:root' },
    };

    // Seed 19 990 tokens; the turn will add exactly 10 more → 20 000 total (at-threshold, no fire).
    await graph.updateState(config, {
      messages: [new HumanMessage('x'.repeat(79_960))],
      cursor: 1, // consumed seq=0 (u-0); next turn picks up seq≥1
    });

    channel.append({
      id: 'u-1',
      author: 'Dennis',
      authorId: 'dennis',
      text: 'Any updates?', // asInput → "Dennis: Any updates?" = 20 chars → 5 tokens
    });

    const stream = await graph.stream(
      { cursor: 1, forced: false },
      { ...config, streamMode: 'updates' as const },
    );
    for await (const _ of stream) {
      /* drain */
    }

    const final = await graph.getState(config);

    // Compaction must NOT have fired.
    expect(final.values.summaries).toHaveLength(0);
    expect(final.values.compactionVersion).toBe(0);
    // LLM was called exactly once (llmNode only; no compaction summarisation call).
    expect(callCount).toBe(1);
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
