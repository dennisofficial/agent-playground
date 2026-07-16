import { describe, expect, it, vi } from 'vitest';
import { LiveTurnStore } from './live-turn-store';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import {
  type BlockSink,
  EntityTaskEventSink,
  type SubagentStore,
  TurnHarnessFactory,
} from './turn-harness.service';

/**
 * The shared transcript spine — converts an engine turn's events into durable blocks (+ optional usage
 * harvest). Live push is a separate, independently-tested concern in `redis-engine-runner`'s realtime
 * consumer group. Lifted verbatim from the brain's former `makeTurnStreamer`; these lock the
 * role-parameterization (lane + metaTag) and the idempotent finalization (finish/abort run once; late
 * events are dropped).
 */
function setup() {
  const live = new LiveTurnStore();
  const persisted: Array<{
    jobId: string;
    block: {
      kind: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      subagentId?: string;
    };
  }> = [];
  const sink: BlockSink = {
    appendBlock: vi.fn(async (jobId, block) => {
      persisted.push({ jobId, block });
      return `msg-${persisted.length - 1}`;
    }),
    appendBlockOnce: vi.fn(async (jobId, promptKey, block) => {
      // Mirror MessageBlockSink: skip if an agent_prompt row already carries this key; else stamp it in.
      if (
        persisted.some(
          (p) =>
            p.block.kind === 'agent_prompt' &&
            (p.block.meta as { promptKey?: string } | null)?.promptKey ===
              promptKey,
        )
      ) {
        return;
      }
      persisted.push({
        jobId,
        block: { ...block, meta: { ...(block.meta ?? {}), promptKey } },
      });
    }),
  };
  const usage = {
    applyHarvest: vi.fn().mockResolvedValue(undefined),
  } as unknown as OauthUsageService;
  const subagentUpserts: Array<Parameters<SubagentStore['upsert']>[0]> = [];
  const subagentStore: SubagentStore = {
    upsert: vi.fn(async (input) => {
      subagentUpserts.push(input);
    }),
  };
  return {
    live,
    persisted,
    subagentStore,
    subagentUpserts,
    factory: new TurnHarnessFactory(live, sink, usage, subagentStore),
  };
}

describe('TurnHarnessFactory — the shared transcript spine', () => {
  it('finish: streams live then persists authoritative blocks tagged with the role metaTag, and ends the lane', async () => {
    const { live, persisted, factory } = setup();
    const h = factory.create({
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'phase:s1',
      metaTag: { phaseId: 's1', batchOrdinal: 2 },
    });
    h.onEvent({ kind: 'thinking', text: 'plan' });
    h.onEvent({ kind: 'text', text: 'hi' });
    h.onEvent({
      kind: 'tool_use',
      id: 't1',
      name: 'Edit',
      input: { file_path: 'a' },
    });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });

    await h.finish('hi');

    // Authoritative blocks persisted at turn END, every one tagged with the phase metaTag.
    expect(persisted.map((p) => p.block.kind)).toEqual([
      'thinking',
      'chat',
      'tool',
    ]);
    expect(
      persisted.every(
        (p) =>
          p.block.meta?.phaseId === 's1' && p.block.meta?.batchOrdinal === 2,
      ),
    ).toBe(true);
    const tool = persisted.find((p) => p.block.kind === 'tool')!;
    expect(tool.block.meta).toMatchObject({
      name: 'Edit',
      result: 'ok',
      phaseId: 's1',
    });
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
    const h = factory.create({
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'main',
    });
    // The orchestrator spawns a subagent (the Task anchor, meta.id === 'task-1').
    h.onEvent({
      kind: 'tool_use',
      id: 'task-1',
      name: 'Task',
      input: { subagent_type: 'explore' },
    });
    // Two subagent round-trips report their OWN occupancy — the LAST wins on the durable anchor.
    h.onEvent({
      kind: 'usage',
      parentToolUseId: 'task-1',
      contextTokens: 5_000,
      contextModel: 'claude-sonnet-5',
      contextLimit: 1_000_000,
    });
    h.onEvent({
      kind: 'usage',
      parentToolUseId: 'task-1',
      contextTokens: 9_000,
      contextModel: 'claude-sonnet-5',
      contextLimit: 1_000_000,
    });
    // A main-agent (untagged) usage frame must NOT stamp any tool block.
    h.onEvent({
      kind: 'usage',
      contextTokens: 42_000,
      contextModel: 'claude-opus-4-8',
      contextLimit: 1_000_000,
    });
    await h.finish('done');

    const anchor = persisted.find(
      (p) => p.block.kind === 'tool' && p.block.meta?.id === 'task-1',
    )!;
    expect(anchor.block.meta).toMatchObject({
      subContextTokens: 9_000,
      subContextLimit: 1_000_000,
      subContextModel: 'claude-sonnet-5',
    });
  });

  it('emitPrompt: persists an agent_prompt block tagged with the lane metaTag + promptKey, and dedups by key', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'codex-review:T',
      metaTag: { codexReviewId: 'T' },
    });
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
    const h = factory.create({
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'phase:s1',
      metaTag: { phaseId: 's1' },
    });
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
      jobId: 'T',
      threadId: 'th1',
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
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'main',
      metaTag: { doneWakeGen: 3, doneWakeThreadId: 'th-mr' },
    });
    h.onEvent({ kind: 'thinking', text: 'review' });
    h.onEvent({ kind: 'text', text: 'What shipped — …' });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'ok' });
    await h.finish('What shipped — …', {
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    // Every persisted block (including the turn_meta divider) carries the wake tag → supersede can find them.
    expect(
      persisted.every(
        (p) =>
          p.block.meta?.doneWakeGen === 3 &&
          p.block.meta?.doneWakeThreadId === 'th-mr',
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
    const { persisted, factory, live } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    // The live turn state (its `startedAt` clock) is created by the realtime consumer group in production,
    // not by the harness's onEvent — simulate that push so `finish` can read the "worked <elapsed>" clock.
    live.push('R', 'T', { kind: 'text', text: 'reply' });
    h.onEvent({ kind: 'text', text: 'reply' });
    await h.finish('reply', {
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 1100,
        costUsd: 0.02,
        model: 'claude-opus-4-8',
      },
      contextTokens: 1200,
      contextLimit: 1_000_000,
    });

    const kinds = persisted.map((p) => p.block.kind);
    expect(kinds).toEqual(['chat', 'turn_meta']); // turn_meta sorts last
    const meta = persisted.at(-1)!.block.meta!;
    expect(meta.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.02,
      model: 'claude-opus-4-8',
    });
    expect(meta.contextTokens).toBe(1200);
    expect(meta.contextLimit).toBe(1_000_000);
    // Per-turn work duration: computed from the still-live turn's `startedAt` (populated by the realtime
    // consumer group), so the footer can show "worked <elapsed>". A non-negative number in ms.
    expect(typeof meta.workedMs).toBe('number');
    expect(meta.workedMs as number).toBeGreaterThanOrEqual(0);
  });

  it('finish turn_meta: carries no workedMs when the turn pushed no events (no live start captured)', async () => {
    const { persisted, factory } = setup();
    // No `onEvent` at all → no live turn state → `snapshot` is null → duration is simply omitted.
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    await h.finish('reply', {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        model: 'claude-opus-4-8',
      },
    });
    const meta = persisted.find((p) => p.block.kind === 'turn_meta')!.block
      .meta!;
    expect(meta.workedMs).toBeUndefined();
  });

  it('finish turn_meta: persists engine diagnostics from turn_debug even without usage', async () => {
    const { persisted, factory } = setup();
    const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
    h.onEvent({ kind: 'text', text: 'reply' });
    h.onEvent({
      kind: 'turn_debug',
      terminalReason: 'completed',
      stopReason: 'end_turn',
    });
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
    const h = factory.create({
      jobId: 'T',
      threadId: 'th1',
      channel: 'R',
      lane: 'phase:s1',
      metaTag: { phaseId: 's1' },
    });
    h.onEvent({ kind: 'tool_use', id: 't1', name: 'Bash', input: {} });
    h.onEvent({ kind: 'tool_result', id: 't1', result: 'done' });
    await h.finish('summary report');
    const chat = persisted.find((p) => p.block.kind === 'chat');
    expect(chat?.block.text).toBe('summary report');
    expect(chat?.block.meta).toMatchObject({ phaseId: 's1' });
  });

  describe('subagent tracking (d4)', () => {
    it('a spawned Task upserts a subagents row on finish, and tags its child blocks with the same subagent_id', async () => {
      const { persisted, subagentUpserts, factory } = setup();
      const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
      h.onEvent({
        kind: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: { subagent_type: 'explore' },
      });
      h.onEvent({
        kind: 'text',
        text: 'exploring…',
        parentToolUseId: 'task-1',
      });
      await h.finish();

      expect(subagentUpserts).toHaveLength(1);
      expect(subagentUpserts[0]).toMatchObject({
        agentType: 'explore',
        status: 'done',
        threadId: 'th1',
      });
      expect(subagentUpserts[0].parentMessageId).toBeTruthy();

      const child = persisted.find((p) => p.block.kind === 'chat')!;
      expect(child.block.subagentId).toBe(subagentUpserts[0].id);

      const anchor = persisted.find((p) => p.block.kind === 'tool')!;
      expect(anchor.block.subagentId).toBeUndefined();
    });

    it('an explicit bg_task settlement before finish wins over the finish-sweep', async () => {
      const { subagentUpserts, factory } = setup();
      const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
      h.onEvent({
        kind: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: { subagent_type: 'implement' },
      });
      h.onEvent({
        kind: 'bg_task',
        status: 'failed',
        parentToolUseId: 'task-1',
      });
      await h.finish();

      expect(subagentUpserts).toHaveLength(1);
      expect(subagentUpserts[0].status).toBe('failed');
    });

    it('abort leaves a still-running subagent as running (no fabricated completion)', async () => {
      const { subagentUpserts, factory } = setup();
      const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
      h.onEvent({
        kind: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: { subagent_type: 'explore' },
      });
      await h.abort();

      expect(subagentUpserts).toHaveLength(1);
      expect(subagentUpserts[0].status).toBe('running');
    });

    it('resolves the eventual model from the LATEST subagent-tagged usage frame', async () => {
      const { subagentUpserts, factory } = setup();
      const h = factory.create({ jobId: 'T', threadId: 'th1', channel: 'R' });
      h.onEvent({
        kind: 'tool_use',
        id: 'task-1',
        name: 'Task',
        input: { subagent_type: 'explore' },
      });
      h.onEvent({
        kind: 'usage',
        parentToolUseId: 'task-1',
        contextTokens: 5_000,
        contextModel: 'claude-sonnet-5',
        contextLimit: 1_000_000,
      });
      h.onEvent({
        kind: 'usage',
        parentToolUseId: 'task-1',
        contextTokens: 9_000,
        contextModel: 'claude-opus-4-8',
        contextLimit: 1_000_000,
      });
      await h.finish();

      expect(subagentUpserts).toHaveLength(1);
      expect(subagentUpserts[0].model).toBe('claude-opus-4-8');
    });
  });
});

describe('EntityTaskEventSink — #N (ordinal) CRUD on the thread-group-owned tasks rows', () => {
  /** A minimal in-memory `tasks` table stand-in, keyed by row id. Honors the `thread_group_id` filter on
   *  find/findOne and ordinal ordering on find, so the sink's queries behave as they would against PG. */
  function fakeTasksRepo(
    seed: Array<{
      id: string;
      title: string;
      status: string;
      ordinal?: number;
      blocked_by?: string[];
    }>,
  ) {
    type Row = {
      id: string;
      thread_group_id: string;
      org_id: string;
      ordinal: number;
      title: string;
      brief: string | null;
      active_form: string | null;
      status: string;
      blocked_by: string[];
    };
    const rows = new Map<string, Row>(
      seed.map((r) => [
        r.id,
        {
          thread_group_id: 'S',
          org_id: 'O',
          ordinal: 10,
          brief: null,
          active_form: null,
          blocked_by: [],
          ...r,
        },
      ]),
    );
    let nextId = 100;
    const matches = (row: Row, where: Partial<Row> = {}) =>
      (where.id === undefined || row.id === where.id) &&
      (where.thread_group_id === undefined ||
        row.thread_group_id === where.thread_group_id) &&
      (where.ordinal === undefined || row.ordinal === where.ordinal);
    return {
      rows,
      find: vi.fn(async ({ where }: { where?: Partial<Row> } = {}) =>
        [...rows.values()]
          .filter((r) => matches(r, where))
          .sort((a, b) => a.ordinal - b.ordinal),
      ),
      findOne: vi.fn(async ({ where }: { where?: Partial<Row> } = {}) => {
        const hit = [...rows.values()].find((r) => matches(r, where));
        return hit ?? null;
      }),
      create: vi.fn((partial: Record<string, unknown>) => ({ ...partial })),
      save: vi.fn(async (partial: Record<string, unknown>) => {
        const id = String(nextId++);
        const row = { id, ...partial } as Row;
        rows.set(id, row);
        return row;
      }),
      update: vi.fn(
        async (where: { id: string }, patch: Record<string, unknown>) => {
          const row = rows.get(where.id);
          if (row) rows.set(where.id, { ...row, ...patch });
        },
      ),
      delete: vi.fn(async (where: { id: string }) => {
        rows.delete(where.id);
      }),
      createQueryBuilder: () => ({
        select: () => ({
          where: () => ({
            // Mirror the real `MAX(ordinal)` over CURRENT rows — recomputed each call so a delete of the
            // highest #N lowers the max (and the next create reuses that number).
            getRawOne: async () => ({
              max: [...rows.values()].reduce(
                (m, r) => Math.max(m, r.ordinal),
                0,
              ),
            }),
          }),
        }),
      }),
    };
  }

  const threadSink = (tasks: ReturnType<typeof fakeTasksRepo>) => {
    const threadGroups = { findOne: vi.fn(async () => ({ id: 'S', org_id: 'O' })) };
    const threads = {
      findOne: vi.fn(async () => ({ id: 'th1', thread_group_id: 'S', org_id: 'O' })),
    };
    return new EntityTaskEventSink(
      threads as never,
      threadGroups as never,
      tasks as never,
    );
  };
  const scope = { kind: 'thread' as const, id: 'th1' };

  /** Find a stored row by its per-stage ordinal (the #N the tool surface now uses as the id). */
  const byOrdinal = (
    tasks: ReturnType<typeof fakeTasksRepo>,
    ordinal: number,
  ) => [...tasks.rows.values()].find((r) => r.ordinal === ordinal);

  it('createTask returns the short per-stage #N (dense) and updateTask by that #N hits the SAME row', async () => {
    const tasks = fakeTasksRepo([]);
    const sink = threadSink(tasks);

    const a = await sink.createTask(scope, { subject: 'A' });
    const b = await sink.createTask(scope, { subject: 'B' });
    expect(a.id).toBe('1');
    expect(b.id).toBe('2');
    expect([...tasks.rows.values()].map((r) => r.ordinal).sort()).toEqual([
      1, 2,
    ]);

    // The #N returned by createTask IS a valid updateTask key — resolved by (thread_group_id, ordinal).
    const res = await sink.updateTask(scope, {
      taskId: '2',
      status: 'in_progress',
    });
    expect(res).toEqual({ ok: true });
    expect(byOrdinal(tasks, 2)?.status).toBe('in_progress');
  });

  it('updateTask status:deleted removes the row; an unknown #N and a non-numeric taskId both error', async () => {
    const tasks = fakeTasksRepo([
      { id: 'u1', title: 'a', status: 'pending', ordinal: 1 },
    ]);
    const sink = threadSink(tasks);

    expect(
      await sink.updateTask(scope, { taskId: '1', status: 'deleted' }),
    ).toEqual({ ok: true });
    expect([...tasks.rows.keys()]).toEqual([]);

    expect(
      await sink.updateTask(scope, { taskId: '9', status: 'completed' }),
    ).toEqual({ ok: false, error: 'task 9 not found' });
    expect(
      await sink.updateTask(scope, { taskId: 'nope', status: 'completed' }),
    ).toEqual({ ok: false, error: 'invalid taskId nope' });
  });

  it('readTasks surfaces the ordinal as #N, ordinal-ordered, mapped to TaskItem', async () => {
    const tasks = fakeTasksRepo([
      { id: 'u2', title: 'second', status: 'pending', ordinal: 2 },
      { id: 'u1', title: 'first', status: 'completed', ordinal: 1 },
    ]);
    const sink = threadSink(tasks);

    expect(await sink.readTasks(scope)).toEqual([
      { id: '1', subject: 'first', status: 'completed' },
      { id: '2', subject: 'second', status: 'pending' },
    ]);
  });

  it('deleting the highest #N lets the next create reuse that number; lower ids are unaffected', async () => {
    const tasks = fakeTasksRepo([]);
    const sink = threadSink(tasks);
    await sink.createTask(scope, { subject: 'A' }); // #1
    await sink.createTask(scope, { subject: 'B' }); // #2

    await sink.updateTask(scope, { taskId: '2', status: 'deleted' });
    const c = await sink.createTask(scope, { subject: 'C' });
    expect(c.id).toBe('2'); // reused — max(ordinal) is 1 again after the delete

    expect(await sink.readTasks(scope)).toEqual([
      { id: '1', subject: 'A', status: 'pending' },
      { id: '2', subject: 'C', status: 'pending' },
    ]);
  });

  it('serializes concurrent creates on one scope so they get distinct dense ordinals', async () => {
    const tasks = fakeTasksRepo([]);
    const sink = threadSink(tasks);

    await Promise.all([
      sink.createTask(scope, { subject: 'A' }),
      sink.createTask(scope, { subject: 'B' }),
    ]);

    const ordinals = [...tasks.rows.values()].map((r) => r.ordinal).sort();
    expect(ordinals).toEqual([1, 2]); // no collision — the second create saw the first's write
  });

  it('createTask stores blockedBy as #N (dropping unknown #N); addBlocks writes the source #N onto the target', async () => {
    const tasks = fakeTasksRepo([
      { id: 'u1', title: 'a', status: 'pending', ordinal: 1 },
    ]);
    const sink = threadSink(tasks);

    const blocked = await sink.createTask(scope, {
      subject: 'blocked',
      blockedBy: ['1', '9'],
    });
    expect(blocked.id).toBe('2');
    expect(byOrdinal(tasks, 2)?.blocked_by).toEqual(['1']); // '9' dropped — no such row

    // "this new task blocks #1" → #1 now waits on the new task's #N (not a uuid).
    const blocker = await sink.createTask(scope, {
      subject: 'blocker',
      addBlocks: ['1'],
    });
    expect(blocker.id).toBe('3');
    expect(byOrdinal(tasks, 1)?.blocked_by).toEqual(['3']);
  });

  it('updateTask recomputes blockedBy in #N space (add then remove)', async () => {
    const tasks = fakeTasksRepo([
      { id: 'u1', title: 'a', status: 'pending', ordinal: 1 },
      { id: 'u2', title: 'b', status: 'pending', ordinal: 2 },
    ]);
    const sink = threadSink(tasks);

    await sink.updateTask(scope, { taskId: '2', addBlockedBy: ['1', '9'] });
    expect(byOrdinal(tasks, 2)?.blocked_by).toEqual(['1']); // '9' dropped

    await sink.updateTask(scope, { taskId: '2', removeBlockedBy: ['1'] });
    expect(byOrdinal(tasks, 2)?.blocked_by).toEqual([]);
  });

  it('delete removes the deleted #N from sibling blockedBy edges', async () => {
    const tasks = fakeTasksRepo([
      { id: 'u1', title: 'blocker', status: 'pending', ordinal: 1 },
      {
        id: 'u2',
        title: 'blocked',
        status: 'pending',
        ordinal: 2,
        blocked_by: ['1'],
      },
    ]);
    const sink = threadSink(tasks);

    expect(
      await sink.updateTask(scope, { taskId: '1', status: 'deleted' }),
    ).toEqual({ ok: true });
    expect(byOrdinal(tasks, 2)?.blocked_by).toEqual([]);
  });
});
