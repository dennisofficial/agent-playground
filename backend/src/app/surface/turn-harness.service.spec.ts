import { describe, expect, it, vi } from 'vitest';
import { LiveTurnStore } from './live-turn-store';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import {
  type BlockSink,
  EntityTaskEventSink,
  type TaskEventSink,
  TurnHarnessFactory,
} from './turn-harness.service';

/**
 * The shared transcript spine — converts an engine turn's events into a live lane push + durable blocks.
 * Lifted verbatim from the brain's former `makeTurnStreamer`; these lock the role-parameterization
 * (lane + metaTag) and the idempotent finalization (finish/abort run once; late events are dropped).
 */
function setup() {
  const live = new LiveTurnStore();
  const persisted: Array<{ jobId: string; block: { kind: string; text?: string; meta?: Record<string, unknown> | null } }> = [];
  const sink: BlockSink = {
    appendBlock: vi.fn(async (jobId, block) => {
      persisted.push({ jobId, block });
    }),
    appendBlockOnce: vi.fn(async (jobId, promptKey, block) => {
      // Mirror MessageBlockSink: skip if an agent_prompt row already carries this key; else stamp it in.
      if (
        persisted.some(
          (p) => p.block.kind === 'agent_prompt' && (p.block.meta as { promptKey?: string } | null)?.promptKey === promptKey,
        )
      ) {
        return;
      }
      persisted.push({ jobId, block: { ...block, meta: { ...(block.meta ?? {}), promptKey } } });
    }),
  };
  const taskSink: TaskEventSink = { applyTaskEvent: vi.fn(async () => undefined) };
  const usage = { applyHarvest: vi.fn().mockResolvedValue(undefined) } as unknown as OauthUsageService;
  return { live, persisted, taskSink, factory: new TurnHarnessFactory(live, sink, taskSink, usage) };
}

describe('TurnHarnessFactory — the shared transcript spine', () => {
  it('finish: streams live then persists authoritative blocks tagged with the role metaTag, and ends the lane', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1', batchOrdinal: 2 } });
    h.onEvent({ kind: 'thinking', text: 'plan' });
    h.onEvent({ kind: 'text', text: 'hi' });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a' } });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });

    // DURING the turn the live lane is the sole source of in-flight blocks.
    expect(live.snapshot('R', 'T', 'phase:s1')!.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool']);

    await h.finish('hi');

    // Authoritative blocks persisted at turn END, every one tagged with the phase metaTag.
    expect(persisted.map((p) => p.block.kind)).toEqual(['thinking', 'chat', 'tool']);
    expect(persisted.every((p) => p.block.meta?.phaseId === 's1' && p.block.meta?.batchOrdinal === 2)).toBe(true);
    const tool = persisted.find((p) => p.block.kind === 'tool')!;
    expect(tool.block.meta).toMatchObject({ name: 'Edit', result: 'ok', phaseId: 's1' });
    // Lane ended (the durable rows now take over).
    expect(live.snapshot('R', 'T', 'phase:s1')).toBeNull();
  });

  it('resetLane silently clears a live lane (no turn_end) and is a guarded no-op on an empty lane', () => {
    const { live, factory } = setup();
    const frames: Array<{ event: { kind?: string } }> = [];
    const sub = live.stream$.subscribe((f) => frames.push(f as never));

    // Empty lane → guarded no-op (the empty boot path): nothing dropped, nothing fanned.
    factory.resetLane('R', 'T');
    expect(live.snapshot('R', 'T', 'main')).toBeNull();
    expect(frames).toHaveLength(0);

    // Open a lane, then resetLane clears it WITHOUT fanning a turn_end (silent — avoids racing the client
    // reconcile before a reattach's '0-0' replay).
    live.push('R', 'T', { kind: 'text_delta', text: 'Hi' });
    expect(live.snapshot('R', 'T', 'main')).not.toBeNull();
    const before = frames.length;
    factory.resetLane('R', 'T');
    sub.unsubscribe();

    expect(live.snapshot('R', 'T', 'main')).toBeNull();
    expect(frames.slice(before)).toHaveLength(0); // no frame at all, in particular no turn_end
  });

  it('usage: a subagent-tagged occupancy stamps its anchor Task block; a main-agent one does not', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R', lane: 'main' });
    // The orchestrator spawns a subagent (the Task anchor, meta.id === 'task-1').
    h.onEvent({ kind: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'explore' } });
    // Two subagent round-trips report their OWN occupancy — the LAST wins on the durable anchor.
    h.onEvent({ kind: 'usage', parentToolUseId: 'task-1', contextTokens: 5_000, contextModel: 'claude-sonnet-5', contextLimit: 1_000_000 });
    h.onEvent({ kind: 'usage', parentToolUseId: 'task-1', contextTokens: 9_000, contextModel: 'claude-sonnet-5', contextLimit: 1_000_000 });
    // A main-agent (untagged) usage frame must NOT stamp any tool block.
    h.onEvent({ kind: 'usage', contextTokens: 42_000, contextModel: 'claude-opus-4-8', contextLimit: 1_000_000 });
    await h.finish('done');

    const anchor = persisted.find((p) => p.block.kind === 'tool' && p.block.meta?.id === 'task-1')!;
    expect(anchor.block.meta).toMatchObject({
      subContextTokens: 9_000,
      subContextLimit: 1_000_000,
      subContextModel: 'claude-sonnet-5',
    });
  });

  it('emitPrompt: persists an agent_prompt block tagged with the lane metaTag + promptKey, and dedups by key', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R', lane: 'codex-review:T', metaTag: { codexReviewId: 'T' } });
    await h.emitPrompt('review THIS plan', 'codex:T:0', { reviewRound: 0 });
    // A second emit with the SAME key is a no-op (survives restart/re-kick/re-drive).
    await h.emitPrompt('review THIS plan', 'codex:T:0', { reviewRound: 0 });

    const prompts = persisted.filter((p) => p.block.kind === 'agent_prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].block.text).toBe('review THIS plan');
    expect(prompts[0].block.meta).toMatchObject({
      codexReviewId: 'T',
      agentPrompt: true,
      reviewRound: 0,
      promptKey: 'codex:T:0',
    });
  });

  it('emitPrompt: an empty/whitespace task writes nothing', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    await h.emitPrompt('   ', 'brain:s1');
    expect(persisted).toHaveLength(0);
  });

  it('abort: persists partials, ends the lane, is idempotent, and drops late events', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1' } });
    h.onEvent({ kind: 'text', text: 'partial' });
    await h.abort();

    expect(persisted.map((p) => p.block.kind)).toEqual(['chat']);
    expect(live.snapshot('R', 'T', 'phase:s1')).toBeNull();

    // A second finalize (e.g. a finally after a catch) is a no-op, and a late event after close is dropped.
    await h.finish('ignored');
    await h.abort();
    h.onEvent({ kind: 'text', text: 'late' });
    expect(persisted).toHaveLength(1);
  });

  it('discard: ends the lane but persists NOTHING (the partial will be re-delivered in full)', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({
      jobId: 'T', threadId: 'th1',
      channel: 'R',
      lane: 'main',
      metaTag: { doneWakeGen: 2, doneWakeThreadId: 'th-x' },
    });
    h.onEvent({ kind: 'text', text: 'What shipped — truncated par' });
    await h.discard();

    // No durable rows written — the truncated partial never becomes a half-message.
    expect(persisted).toHaveLength(0);
    // …but the live lane is ended (the in-flight buffer is dropped).
    expect(live.snapshot('R', 'T', 'main')).toBeNull();

    // Idempotent + drops late events, like abort/finish.
    await h.finish('ignored');
    h.onEvent({ kind: 'text', text: 'late' });
    expect(persisted).toHaveLength(0);
  });

  it('metaTag doneWakeGen/doneWakeThreadId tags every completion-wake block (chat/thinking/tool)', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({
      jobId: 'T', threadId: 'th1',
      channel: 'R',
      lane: 'main',
      metaTag: { doneWakeGen: 3, doneWakeThreadId: 'th-mr' },
    });
    h.onEvent({ kind: 'thinking', text: 'review' });
    h.onEvent({ kind: 'text', text: 'What shipped — …' });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });
    await h.finish('What shipped — …', { usage: { inputTokens: 1, outputTokens: 1 } as never });

    // Every persisted block (including the turn_meta divider) carries the wake tag → supersede can find them.
    expect(
      persisted.every(
        (p) => p.block.meta?.doneWakeGen === 3 && p.block.meta?.doneWakeThreadId === 'th-mr',
      ),
    ).toBe(true);
  });

  it('brain lane (no metaTag): blocks carry no phase tag; a subagent block keeps its parentToolUseId', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' }); // default `main` lane, no metaTag
    h.onEvent({ kind: 'text', text: 'brain' });
    h.onEvent({ kind: 'text', text: 'sub', parentToolUseId: 'tu1' });
    await h.finish();

    expect(persisted[0].block.meta).toBeUndefined();
    expect(persisted[1].block.meta).toEqual({ parentToolUseId: 'tu1' });
  });

  it('finish turn_meta: appends a turn_meta block LAST carrying usage + context occupancy when usage is given', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    h.onEvent({ kind: 'text', text: 'reply' });
    await h.finish('reply', {
      usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 1100, costUsd: 0.02, model: 'claude-opus-4-8' },
      contextTokens: 1200,
      contextLimit: 1_000_000,
    });

    const kinds = persisted.map((p) => p.block.kind);
    expect(kinds).toEqual(['chat', 'turn_meta']); // turn_meta sorts last
    const meta = persisted.at(-1)!.block.meta!;
    expect(meta.usage).toMatchObject({ inputTokens: 1200, outputTokens: 340, costUsd: 0.02, model: 'claude-opus-4-8' });
    expect(meta.contextTokens).toBe(1200);
    expect(meta.contextLimit).toBe(1_000_000);
    // Per-turn work duration: computed from the still-live turn's `startedAt` (set by the first `onEvent`),
    // so the footer can show "worked <elapsed>". A non-negative number in ms.
    expect(typeof meta.workedMs).toBe('number');
    expect(meta.workedMs as number).toBeGreaterThanOrEqual(0);
  });

  it('finish turn_meta: carries no workedMs when the turn pushed no events (no live start captured)', async () => {
    const { persisted, factory } = setup();
    // No `onEvent` at all → no live turn state → `snapshot` is null → duration is simply omitted.
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    await h.finish('reply', {
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, model: 'claude-opus-4-8' },
    });
    const meta = persisted.find((p) => p.block.kind === 'turn_meta')!.block.meta!;
    expect(meta.workedMs).toBeUndefined();
  });

  it('finish turn_meta: persists engine diagnostics from turn_debug even without usage', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    h.onEvent({ kind: 'text', text: 'reply' });
    h.onEvent({ kind: 'turn_debug', terminalReason: 'completed', stopReason: 'end_turn' });
    h.onEvent({ kind: 'turn_debug', streamClosedCount: 2 });
    await h.finish('reply');

    expect(persisted.map((p) => p.block.kind)).toEqual(['chat', 'turn_meta']);
    const meta = persisted.at(-1)!.block.meta!;
    expect(meta.terminalReason).toBe('completed');
    expect(meta.stopReason).toBe('end_turn');
    expect(meta.streamClosedCount).toBe(2);
    expect(meta.usage).toBeUndefined();
  });

  it('finish without usage: no turn_meta block is written', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    h.onEvent({ kind: 'text', text: 'reply' });
    await h.finish('reply');
    expect(persisted.map((p) => p.block.kind)).toEqual(['chat']);
  });

  it('finish text fallback: a turn that emitted no text persists the final report as a chat block', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R', lane: 'phase:s1', metaTag: { phaseId: 's1' } });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'done' });
    await h.finish('summary report');
    const chat = persisted.find((p) => p.block.kind === 'chat');
    expect(chat?.block.text).toBe('summary report');
    expect(chat?.block.meta).toMatchObject({ phaseId: 's1' });
  });

  describe('task-event capture (LLM-authored task list)', () => {
    it('folds TaskCreate on the stable thread:<id> lane into thread scope', async () => {
      const { taskSink, factory } = setup();
      const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R', lane: 'thread:TH1', metaTag: { phaseId: 's1' } });
      h.onEvent({ kind: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Do the thing' } });
      h.onEvent({ kind: 'tool_result', id: 't1', result: { task: { id: 'tsk1' } } });
      await h.finish();

      expect(taskSink.applyTaskEvent).toHaveBeenCalledWith(
        { kind: 'thread', id: 'TH1' },
        'taskcreate',
        { subject: 'Do the thing' },
        { task: { id: 'tsk1' } },
      );
    });

    it('does NOT fold tasks on an autofix:* lane (not a task-tracked session)', async () => {
      const { taskSink, factory } = setup();
      const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R', lane: 'autofix:AF1:fix' });
      h.onEvent({ kind: 'tool_use', id: 't1', name: 'TaskUpdate', input: { taskId: 'tsk1', status: 'completed' } });
      h.onEvent({ kind: 'tool_result', id: 't1', result: {} });
      await h.finish();

      expect(taskSink.applyTaskEvent).not.toHaveBeenCalled();
    });

    it('ignores a subagent’s own TaskCreate (parentToolUseId set)', async () => {
      const { taskSink, factory } = setup();
      const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R', lane: 'thread:TH1' });
      h.onEvent({ kind: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'x' }, parentToolUseId: 'tu1' });
      h.onEvent({ kind: 'tool_result', id: 't1', result: { task: { id: 'tsk1' } } });
      await h.finish();

      expect(taskSink.applyTaskEvent).not.toHaveBeenCalled();
    });

    it('folds TaskCreate on the default main lane into main scope (the brain’s own checklist)', async () => {
      const { taskSink, factory } = setup();
      const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R' }); // default `main` lane
      h.onEvent({ kind: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Draft the plan' } });
      h.onEvent({ kind: 'tool_result', id: 't1', result: { task: { id: 'tsk1' } } });
      await h.finish();

      expect(taskSink.applyTaskEvent).toHaveBeenCalledWith(
        { kind: 'main', id: 'J' },
        'taskcreate',
        { subject: 'Draft the plan' },
        { task: { id: 'tsk1' } },
      );
    });

    it('ignores task tool calls on lanes that are not task-tracked (phase, autofix, subagent)', async () => {
      const { taskSink, factory } = setup();
      for (const lane of ['phase:s1', 'autofix:J:correctness', 'subagent:tu1']) {
        const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R', lane });
        h.onEvent({ kind: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'x' } });
        h.onEvent({ kind: 'tool_result', id: 't1', result: { task: { id: 'tsk1' } } });
        await h.finish();
      }
      expect(taskSink.applyTaskEvent).not.toHaveBeenCalled();
    });

    it('ignores non-task tool calls even on a task-tracked lane', async () => {
      const { taskSink, factory } = setup();
      const h = factory.create({ jobId: 'J', threadId: 'th1', channel: 'R', lane: 'thread:TH1' });
      h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } });
      h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });
      await h.finish();

      expect(taskSink.applyTaskEvent).not.toHaveBeenCalled();
    });
  });
});

describe('EntityTaskEventSink — the per-scope task fold writer', () => {
  it('serializes concurrent folds on one scope so a batch of updates never loses a write', async () => {
    // A batch turn fires task events fire-and-forget; unserialized, both folds read the same snapshot
    // and the second write erases the first's change (live-observed as "deleted tasks still showing").
    let row: { id: string; tasks: unknown[]; main_tasks: Array<{ id: string; subject: string; status: string }> } = {
      id: 'J',
      tasks: [],
      main_tasks: [
        { id: '1', subject: 'a', status: 'pending' },
        { id: '2', subject: 'b', status: 'pending' },
      ],
    };
    const jobs = {
      findOne: vi.fn(async () => ({ ...row, main_tasks: [...row.main_tasks] })),
      update: vi.fn(async (_where: unknown, patch: Record<string, unknown>) => {
        row = { ...row, ...(patch as Partial<typeof row>) };
      }),
    };
    const threads = { findOne: vi.fn(), update: vi.fn() };
    const sink = new EntityTaskEventSink(threads as never, jobs as never);

    await Promise.all([
      sink.applyTaskEvent({ kind: 'main', id: 'J' }, 'taskupdate', { taskId: '1', status: 'deleted' }, {}),
      sink.applyTaskEvent({ kind: 'main', id: 'J' }, 'taskupdate', { taskId: '2', status: 'deleted' }, {}),
    ]);

    // Deletes REMOVE tasks; without serialization one of the two removals is lost.
    expect(row.main_tasks).toEqual([]);
  });
});
