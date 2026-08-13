import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EHarnessVariant } from '../../domain/message.js';
import { EToolTier } from '../../domain/tool-surface.js';
import {
  EPhaseKind,
  EThreadCondition,
  EThreadRole,
  EThreadStatus,
} from '../../generated/prisma/enums.js';
import type {
  EngineSession,
  Job,
  Phase,
  Thread,
} from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { TransitionRepository } from '../../store/transition.repository.js';
import type { ContextEntry, ContextFolderService } from '../context-folder.service.js';
import type { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import { ThreadSeamService } from '../thread-seam.service.js';
import { fakeShipService } from './ship.fixture.js';
import { fakeWorktreeService } from './worktree.fixture.js';
import { fakeTaskService } from './tasks.fixture.js';
import { completeThreadTool } from '../tools/complete-thread.tool.js';
import { openThreadTool } from '../tools/open-thread.tool.js';
import type { ToolContext } from '../tools/tool.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';

/**
 * `open_thread` and `complete_thread`, end to end with everything faked but the decisions.
 *
 * The claim under test is the round trip: the caller STAYS open, the delegate takes the cursor, and
 * the answer comes back later as a message in the caller rather than as this tool call's return
 * value. A synchronous return would hold the query open for however long that conversation takes.
 */

const JOB = { id: 'job-1', title: 'add avatar upload' } as unknown as Job;
const PHASES = [
  { id: 'phase-1', jobId: JOB.id, kind: EPhaseKind.generic, ordinal: 0 } as unknown as Phase,
];

const ROOT = mkdtempSync(join(tmpdir(), 'atlas-delegation-'));
mkdirSync(join(ROOT, 'charting'), { recursive: true });
writeFileSync(join(ROOT, 'charting', 'map.md'), 'the map, everyone’s');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const LISTING: ContextEntry[] = [
  {
    bucket: 'charting',
    path: 'map.md',
    bytes: 1,
    modifiedAt: new Date(0),
    isDirectory: false,
  },
];

function world(seed?: { threads?: Thread[] }) {
  const threads: Thread[] = seed?.threads ?? [
    {
      id: 'thread-1',
      phaseId: 'phase-1',
      role: EThreadRole.generic,
      status: EThreadStatus.active,
      openedByThreadId: null,
      createdAt: new Date(2026, 0, 1, 12, 0),
    } as unknown as Thread,
  ];
  const turns: RunTurnArgs[] = [];
  const closed: string[] = [];
  const outcomes: { threadId: string; condition: EThreadCondition; resolution?: string }[] = [];
  const cursor: string[] = [];

  const jobRepository = {
    async listPhases(): Promise<Phase[]> {
      return PHASES;
    },
    async setActiveThread(_jobId: string, threadId: string): Promise<void> {
      cursor.push(threadId);
    },
  } as unknown as JobRepository;

  const threadRepository = {
    async findById(id: string): Promise<Thread | null> {
      return threads.find((thread) => thread.id === id) ?? null;
    },
    async openInPhase(phaseId: string): Promise<Thread[]> {
      return threads.filter(
        (thread) =>
          thread.phaseId === phaseId && thread.status !== EThreadStatus.closed,
      );
    },
    async recordOutcome(outcome: {
      threadId: string;
      condition: EThreadCondition;
      resolution?: string;
    }): Promise<void> {
      outcomes.push(outcome);
    },
    async setOpenedBy(args: {
      threadId: string;
      openedByThreadId: string;
    }): Promise<Thread> {
      const index = threads.findIndex((thread) => thread.id === args.threadId);
      const found = threads[index];
      if (!found) throw new Error(`no thread ${args.threadId}`);
      const updated = { ...found, openedByThreadId: args.openedByThreadId };
      threads[index] = updated;
      return updated;
    },
  } as unknown as ThreadRepository;

  const sessionManagerService = {
    async closeThread(thread: Thread): Promise<void> {
      closed.push(thread.id);
      const index = threads.findIndex((row) => row.id === thread.id);
      const found = threads[index];
      if (found) threads[index] = { ...found, status: EThreadStatus.closed };
    },
    // Mirrors the real one: a new thread joins the job's current phase AND stamps the cursor.
    async openThread(jobId: string, role: EThreadRole): Promise<Thread> {
      const thread = {
        id: `thread-${threads.length + 1}`,
        phaseId: 'phase-1',
        role,
        status: EThreadStatus.active,
        openedByThreadId: null,
        createdAt: new Date(2026, 0, 1, 12, threads.length),
      } as unknown as Thread;
      threads.push(thread);
      cursor.push(thread.id);
      void jobId;
      return thread;
    },
    async currentSession(): Promise<EngineSession> {
      return { id: 'session-1', accountId: 'account-1' } as unknown as EngineSession;
    },
  } as unknown as SessionManagerService;

  const service = new ThreadSeamService(
    jobRepository,
    threadRepository,
    {} as unknown as TransitionRepository,
    sessionManagerService,
    {
      async forPhase(): Promise<{ instructions: string; opening: string }> {
        return { instructions: 'generic instructions', opening: 'You are here.' };
      },
    } as unknown as PhaseBriefService,
    {
      list: (): ContextEntry[] => LISTING,
      resolveInside: (ref: { relativePath: string }): string =>
        join(ROOT, ref.relativePath),
    } as unknown as ContextFolderService,
    {
      async run(args: RunTurnArgs): Promise<void> {
        turns.push(args);
      },
    } as unknown as TurnRunnerService,
    fakeTaskService(),
    fakeShipService(),
    fakeWorktreeService(),
  );

  const ctx = (thread: Thread): ToolContext => ({
    job: JOB,
    thread,
    phase: EPhaseKind.generic,
    cwd: '/repo',
    tier: EToolTier.thread,
  });

  return { service, ctx, threads, turns, closed, cursor, outcomes };
}

describe('open_thread', () => {
  it('leaves the caller OPEN, records the opener, and moves the cursor to the new thread', async () => {
    const { service, ctx, threads, closed, cursor } = world();
    const caller = threads[0] as Thread;

    await service.openThread({
      ctx: ctx(caller),
      role: EThreadRole.research,
      brief: 'Does the uploader already resize?',
      attach: [],
    });

    // The whole difference from `advance_thread`: nothing closed. The caller is waiting, not done.
    expect(closed).toEqual([]);
    const delegate = threads[1] as Thread;
    expect(delegate.role).toBe(EThreadRole.research);
    // `openedByThreadId`, never `parentThreadId` — it is a real thread in this phase, not a teammate.
    expect(delegate.openedByThreadId).toBe(caller.id);
    expect(delegate.parentThreadId ?? null).toBeNull();
    expect(cursor).toEqual([delegate.id]);
  });

  it('seeds the delegate with the brief, framed as a thread that is waiting on it', async () => {
    const { service, ctx, threads, turns } = world();

    await service.openThread({
      ctx: ctx(threads[0] as Thread),
      role: EThreadRole.research,
      brief: 'Does the uploader already resize?',
      attach: [],
    });

    const seed = turns[0];
    expect(seed?.thread.id).toBe('thread-2');
    expect(seed?.harnessVariant).toBe(EHarnessVariant.handoff);
    expect(seed?.prompt).toContain('Does the uploader already resize?');
    // A delegate told "that thread is closed" would report back to nobody.
    expect(seed?.prompt).toContain('STILL OPEN');
    expect(seed?.prompt).toContain('complete_thread');
    expect(seed?.prompt).not.toContain('That thread is closed');
    // The phase's opening still orients it, and its standing instructions ride the system prompt.
    expect(seed?.prompt).toContain('You are here.');
    expect(seed?.brief).toBe('generic instructions');
  });

  it('returns no answer — it tells the caller one is coming later, and to stop', async () => {
    const { service, ctx, threads } = world();

    const reply = await service.openThread({
      ctx: ctx(threads[0] as Thread),
      role: EThreadRole.research,
      brief: 'why',
      attach: [],
    });

    expect(reply).toContain('This thread stays open');
    expect(reply).toContain('NO answer here');
    expect(reply).toContain('End your turn');
  });

  it('refuses a role the phase does not host, and opens nothing when it does', async () => {
    const { service, ctx, threads } = world();

    await expect(
      service.openThread({
        ctx: ctx(threads[0] as Thread),
        role: EThreadRole.builder,
        brief: 'why',
        attach: [],
      }),
    ).rejects.toThrow('does not host');
    expect(threads).toHaveLength(1);
  });
});

describe('complete_thread', () => {
  /** A planner that delegated, and the delegate now closing. The round trip's second half. */
  async function delegated() {
    const built = world();
    const caller = built.threads[0] as Thread;
    await built.service.openThread({
      ctx: built.ctx(caller),
      role: EThreadRole.research,
      brief: 'Does the uploader already resize?',
      attach: [],
    });
    built.turns.length = 0;
    built.cursor.length = 0;
    return { ...built, caller, delegate: built.threads[1] as Thread };
  }

  it('reports back to the opener, returns the cursor there, and fires a turn on it', async () => {
    const { service, ctx, caller, delegate, turns, closed, cursor, outcomes } =
      await delegated();

    await service.completeThread({
      ctx: ctx(delegate),
      condition: EThreadCondition.resolved,
      resolution: 'It resizes on upload, in `uploader.ts`.',
    });

    expect(closed).toEqual([delegate.id]);
    // The opener's copy of this is a message in ANOTHER thread, so the row keeps its own: a closed
    // thread has to be able to say how it ended without anyone reading a transcript.
    expect(outcomes).toEqual([
      {
        threadId: delegate.id,
        condition: EThreadCondition.resolved,
        resolution: 'It resizes on upload, in `uploader.ts`.',
      },
    ]);
    expect(cursor).toEqual([caller.id]);
    // The auto-fired turn IS the report: the opener was blocked on this and nothing else would
    // start it. Serial activation already auto-starts a turn, so this is not a new mechanism.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.thread.id).toBe(caller.id);
    expect(turns[0]?.harnessVariant).toBe(EHarnessVariant.handoff);
    expect(turns[0]?.prompt).toContain('It resizes on upload');
    expect(turns[0]?.prompt).toContain('resolved');
  });

  it('hands the cursor to a sibling when nothing opened it, and fires nothing', async () => {
    const { service, ctx, caller, delegate, turns, cursor } = await delegated();

    // The plain case: a thread that simply finished. Nobody is waiting, so nobody is told.
    await service.completeThread({
      ctx: ctx({ ...delegate, openedByThreadId: null } as Thread),
      condition: EThreadCondition.blocked,
      resolution: 'Needs the API key first.',
    });

    expect(cursor).toEqual([caller.id]);
    expect(turns).toEqual([]);
  });

  it('throws for the LAST open thread in the phase, and closes nothing', async () => {
    const { service, ctx, threads, closed, cursor } = world();

    await expect(
      service.completeThread({
        ctx: ctx(threads[0] as Thread),
        condition: EThreadCondition.resolved,
        resolution: 'done',
      }),
    ).rejects.toThrow('last open thread');
    expect(closed).toEqual([]);
    expect(cursor).toEqual([]);
  });

  it('never evaluates a phase gate — closing is not how a phase ends', async () => {
    const { service, ctx, delegate } = await delegated();
    // With `transitionRepository` faked as `{}`, raising one would throw. It resolves, so nothing
    // here so much as looked at the phase's exit.
    await expect(
      service.completeThread({
        ctx: ctx(delegate),
        condition: EThreadCondition.resolved,
        resolution: 'done',
      }),
    ).resolves.toContain('closed as resolved');
  });
});

describe('the tools', () => {
  it('offers open_thread exactly the roles the phase hosts', () => {
    const { service, ctx, threads } = world();
    const tool = openThreadTool({ ctx: ctx(threads[0] as Thread), actions: service });

    const schema = z.object(tool?.shape ?? {});
    const call = { brief: 'why', attach: [] };
    expect(schema.safeParse({ ...call, role: EThreadRole.research }).success).toBe(true);
    // `generic` does not host builders, and the schema is the rail rather than a later refusal.
    expect(schema.safeParse({ ...call, role: EThreadRole.builder }).success).toBe(false);
    // `attach` is required: an empty array is a statement, an omission is not.
    expect(schema.safeParse({ role: EThreadRole.research, brief: 'why' }).success).toBe(false);
  });

  it('offers complete_thread only the conditions an agent may claim of itself', () => {
    const { service, ctx, threads } = world();
    const tool = completeThreadTool({ ctx: ctx(threads[0] as Thread), actions: service });

    const schema = z.object(tool?.shape ?? {});
    expect(
      schema.safeParse({ condition: EThreadCondition.resolved, resolution: 'x' }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ condition: EThreadCondition.handed_off, resolution: 'x' }).success,
    ).toBe(false);
  });

  it('routes a parsed call straight through to the seam', async () => {
    const { service, ctx, threads, cursor } = world();
    const tool = openThreadTool({ ctx: ctx(threads[0] as Thread), actions: service });

    const reply = await tool?.handler({
      role: EThreadRole.research,
      brief: 'why',
      attach: [],
    });

    expect(reply).toContain('research thread is open');
    expect(cursor).toEqual(['thread-2']);
  });
});
