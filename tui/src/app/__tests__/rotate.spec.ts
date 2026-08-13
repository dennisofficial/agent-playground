import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EHarnessVariant } from '../../domain/message.js';
import type { TaskView } from '../../domain/tasks.js';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import {
  EPhaseKind,
  ESessionEndReason,
  ETaskStatus,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Phase, Thread } from '../../generated/prisma/client.js';
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
import { atlasToolsFor } from '../tools/registry.js';
import { rotateTool } from '../tools/rotate.tool.js';
import type { ToolContext } from '../tools/tool.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';

/**
 * `rotate`, end to end with everything faked but the decisions.
 *
 * The claim under test is that one act does both halves: when the tool resolves, the leg the agent
 * was on is closed AND the leg carrying its report is open and has been given a turn. Anything that
 * split those two would leave a session working past the point it declared its context spent.
 */

const JOB = { id: 'job-1', title: 'add avatar upload' } as unknown as Job;
const THREAD = {
  id: 'thread-1',
  phaseId: 'phase-1',
  role: EThreadRole.builder,
  activeSessionId: 'session-1',
} as unknown as Thread;
const PHASES = [{ id: 'phase-1', kind: EPhaseKind.build } as unknown as Phase];
const CURRENT = { id: 'session-1', ordinal: 3 } as unknown as EngineSession;
const NEXT = { id: 'session-2', ordinal: 4 } as unknown as EngineSession;

const SECTIONS = {
  done: 'Slice 3’s upload route is written and `bun test` is green.',
  tried_and_rejected: 'A shared cache — the invalidation is per-job, so it never paid for itself.',
  surprises: 'The fetch wrapper adds an auth header and it breaks the signature.',
  next: 'Wire slice 4’s thumbnailer.',
};

const ROOT = mkdtempSync(join(tmpdir(), 'atlas-rotate-'));
mkdirSync(join(ROOT, 'specs'), { recursive: true });
writeFileSync(join(ROOT, 'specs', 'spec.md'), 'the plan, shared by everyone');
writeFileSync(join(ROOT, 'specs', '03-slice.md'), 'slice three, one thread’s');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const LISTING: ContextEntry[] = ['spec.md', '03-slice.md'].map((path) => ({
  bucket: 'specs',
  path,
  bytes: 1,
  modifiedAt: new Date(0),
  isDirectory: false,
}));

function build(tasks: readonly TaskView[] = []) {
  const rotations: {
    thread: Thread;
    current: EngineSession;
    endReason: ESessionEndReason;
    handoff?: string;
  }[] = [];
  const turns: RunTurnArgs[] = [];
  const closedThreads: string[] = [];

  const service = new ThreadSeamService(
    { async listPhases(): Promise<Phase[]> { return PHASES; } } as unknown as JobRepository,
    {} as unknown as ThreadRepository,
    {} as unknown as TransitionRepository,
    {
      // Reads the thread's own pointer, as the real one does — which is the trap a rotation walks
      // into: the caller's row still names the leg that was just retired.
      async currentSession(thread: Thread): Promise<EngineSession> {
        return thread.activeSessionId === NEXT.id ? NEXT : CURRENT;
      },
      async rotateSession(
        thread: Thread,
        current: EngineSession,
        endReason: ESessionEndReason,
        handoff?: string,
      ): Promise<EngineSession> {
        rotations.push({ thread, current, endReason, ...(handoff ? { handoff } : {}) });
        return NEXT;
      },
      // A rotation must touch neither: same thread, same cursor, same job.
      async closeThread(thread: Thread): Promise<void> {
        closedThreads.push(thread.id);
      },
      async openThread(): Promise<Thread> {
        throw new Error('a rotation must not open a thread');
      },
    } as unknown as SessionManagerService,
    {
      async forPhase(): Promise<{ instructions: string; opening: string }> {
        return { instructions: 'build instructions', opening: 'You are building.' };
      },
    } as unknown as PhaseBriefService,
    {
      list: (): ContextEntry[] => LISTING,
      resolveInside: (args: { relativePath: string }): string => join(ROOT, args.relativePath),
    } as unknown as ContextFolderService,
    {
      async run(args: RunTurnArgs): Promise<void> {
        turns.push(args);
      },
    } as unknown as TurnRunnerService,
    fakeTaskService(tasks),
    fakeShipService(),
    fakeWorktreeService(),
  );

  const ctx: ToolContext = {
    job: JOB,
    thread: THREAD,
    phase: EPhaseKind.build,
    cwd: '/repo',
    tier: EToolTier.thread,
  };

  return { service, ctx, rotations, turns, closedThreads };
}

async function rotate(harness: ReturnType<typeof build>, attach: string[] = []) {
  const tool = rotateTool({ ctx: harness.ctx, actions: harness.service });
  return tool?.handler({ ...SECTIONS, attach });
}

describe('rotate', () => {
  it('ends this session and opens the next one, as ONE act — no window in between', async () => {
    const harness = build();

    const reply = await rotate(harness);

    expect(harness.rotations).toHaveLength(1);
    expect(harness.rotations[0]?.endReason).toBe(ESessionEndReason.context_pressure);
    // The successor's first turn has already been fired by the time the tool answers: there is no
    // state in which the hand-off exists and the session has not turned over.
    expect(harness.turns).toHaveLength(1);
    expect(reply).toContain('Session 3 is closed');
    expect(reply).toContain('Session 4 is open');
  });

  it('keeps the thread — a rotation is not a succession', async () => {
    const harness = build();

    await rotate(harness);

    expect(harness.closedThreads).toEqual([]);
    expect(harness.turns[0]?.thread.id).toBe(THREAD.id);
    // ...and the turn runs on the session the rotation opened, not the one it just retired. The
    // caller's thread row still points at the old one, which is exactly the trap.
    expect(harness.turns[0]?.session.id).toBe(NEXT.id);
  });

  it('stores the four sections verbatim and delivers them as the successor’s first message', async () => {
    const harness = build();

    await rotate(harness);

    const stored = harness.rotations[0]?.handoff ?? '';
    expect(stored).toContain('## Tried and rejected');
    expect(stored).toContain('the invalidation is per-job');

    const seed = harness.turns[0];
    expect(seed?.harnessVariant).toBe(EHarnessVariant.handoff);
    // Its own words, under a heading that says whose they are — the same thread, one leg back.
    expect(seed?.prompt).toContain('your own previous session');
    expect(seed?.prompt).toContain('the invalidation is per-job');
    // The phase's opening and standing instructions come with it, as they do for any seed.
    expect(seed?.prompt).toContain('You are building.');
    expect(seed?.brief).toBe('build instructions');
    expect(seed?.cwd).toBe('/repo');
  });

  it('carries the phase floor even when nothing is declared — a fresh leg has lost everything', async () => {
    const harness = build();

    const reply = await rotate(harness, ['specs/03-slice.md']);

    const attachments = harness.turns[0]?.attachments ?? [];
    expect(attachments.map((part) => part.label)).toEqual([
      'context/specs/spec.md',
      'context/specs/03-slice.md',
    ]);
    expect(reply).toContain('context/specs/03-slice.md');
  });

  it('refuses a file that is not there, before anything is written', async () => {
    const harness = build();

    await expect(rotate(harness, ['specs/nope.md'])).rejects.toThrow('cannot attach');
    expect(harness.rotations).toEqual([]);
    expect(harness.turns).toEqual([]);
  });
});

describe('the rotate tool', () => {
  it('is the only Atlas verb a teammate holds — asserted over the whole registry', () => {
    const harness = build();

    const seen = atlasToolsFor({
      ctx: { ...harness.ctx, tier: EToolTier.teammate },
      actions: harness.service,
    });

    // A teammate is a super-subagent owned by a thread: it never moves a phase, a thread or the
    // cursor. But it runs a session of its own, and a session that cannot hand over can only die.
    expect(seen.map((tool) => tool.name)).toEqual([EAtlasTool.rotate]);
  });

  it('makes the four sections unskippable — the schema is the only rail', () => {
    const harness = build();
    const schema = z.object(rotateTool({ ctx: harness.ctx, actions: harness.service })?.shape ?? {});

    expect(schema.safeParse(SECTIONS).success).toBe(true);
    // The section an agent under context pressure drops first cannot be dropped.
    const { tried_and_rejected: _dropped, ...withoutLesson } = SECTIONS;
    expect(schema.safeParse(withoutLesson).success).toBe(false);
    expect(schema.safeParse({ ...SECTIONS, surprises: '' }).success).toBe(false);
  });

  /**
   * The task list rides the rotation hand-off — ticket 14's one non-cosmetic consequence of Atlas
   * owning tasks instead of `TodoWrite`.
   *
   * ROTATION only, and the distinction is load-bearing: a rotation keeps the SAME thread, so the
   * numbers the next leg inherits are still live and `task_update` still takes them. An
   * `advance_thread` successor is a NEW thread with an empty list of its own, so seeding it with
   * numbers it cannot update would be a lie — which is why this is not in the generic seed.
   */
  it('carries the rendered task list, so the next leg inherits numbers it has never seen', async () => {
    const harness = build([
      { ordinal: 1, text: 'wire the upload route', status: ETaskStatus.completed },
      { ordinal: 3, text: 'thumbnail the image', status: ETaskStatus.in_progress },
    ]);

    await rotate(harness);

    // Stored with the retired leg, so the record of what it was doing is complete...
    expect(harness.rotations[0]?.handoff).toContain('#3 [in_progress] thumbnail the image');
    // ...and in front of the successor, which is the half that stops it calling `#3` into a list it
    // believes is empty. Numbers are gapped because #2 was retired, and they are NOT renumbered.
    const seed = harness.turns[0]?.prompt ?? '';
    expect(seed).toContain('# Your task list');
    expect(seed).toContain('#1 [completed] wire the upload route');
    expect(seed).toContain('#3 [in_progress] thumbnail the image');
  });

  it('carries no task section when the thread has no list — a seed with nothing to say says nothing', async () => {
    const harness = build();

    await rotate(harness);

    expect(harness.turns[0]?.prompt).not.toContain('# Your task list');
  });

  it('leaves notes and attachments optional, unlike the thread and phase seams', async () => {
    const harness = build();
    const tool = rotateTool({ ctx: harness.ctx, actions: harness.service });

    // No `attach`, no `notes`: this is the same thread, so its files came with it.
    await tool?.handler({ ...SECTIONS });

    expect(harness.rotations).toHaveLength(1);
    expect(harness.rotations[0]?.handoff).not.toContain('## Notes');
  });
});
