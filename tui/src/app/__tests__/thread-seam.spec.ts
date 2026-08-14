import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EHarnessVariant, promptPayload, renderPrompt } from '../../domain/message.js';
import { EToolTier } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Phase, Thread } from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { TransitionRepository } from '../../store/transition.repository.js';
import type { ContextEntry, ContextFolderService } from '../context-folder.service.js';
import type { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import { ThreadSeamService } from '../thread-seam.service.js';
import { fakeShipService } from './ship.fixture.js';
import { fakeServiceRegistry } from './services.fixture.js';
import { fakeTaskService } from './tasks.fixture.js';
import { advanceThreadTool } from '../tools/advance-thread.tool.js';
import type { ToolContext } from '../tools/tool.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';

/**
 * `advance_thread`, end to end with everything faked but the decisions.
 *
 * The claim under test is structural rather than textual: one thread closes, exactly one opens, the
 * cursor follows it, and what the successor reads first is the outgoing agent's own words plus the
 * files it was handed — never a summary Atlas wrote.
 */

const JOB = { id: 'job-1', title: 'add avatar upload', branch: null } as unknown as Job;
const THREAD = {
  id: 'thread-1',
  phaseId: 'phase-1',
  role: EThreadRole.builder,
} as unknown as Thread;
const SUCCESSOR = {
  id: 'thread-2',
  phaseId: 'phase-1',
  role: EThreadRole.builder,
} as unknown as Thread;
const PHASES = [
  { id: 'phase-1', kind: EPhaseKind.build, ordinal: 0 } as unknown as Phase,
];

// A real folder with real files: the floor is computed from a listing and the bodies are inlined
// from disk, and a fake filesystem would have proved only that the fake works.
const ROOT = mkdtempSync(join(tmpdir(), 'atlas-seam-'));
mkdirSync(join(ROOT, 'specs'), { recursive: true });
writeFileSync(join(ROOT, 'specs', 'spec.md'), 'the plan, shared by everyone');
writeFileSync(join(ROOT, 'specs', '03-slice.md'), 'slice three, one thread’s');
writeFileSync(join(ROOT, 'specs', '04-slice.md'), 'slice four, not attached');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const LISTING: ContextEntry[] = ['spec.md', '03-slice.md', '04-slice.md'].map(
  (path) => ({
    bucket: 'specs',
    path,
    bytes: 1,
    modifiedAt: new Date(0),
    isDirectory: false,
  }),
);

function build() {
  const closed: string[] = [];
  const outcomes: { threadId: string; condition: string; resolution?: string }[] = [];
  const opened: { jobId: string; role: EThreadRole }[] = [];
  const turns: RunTurnArgs[] = [];

  const service = new ThreadSeamService(
    { async listPhases(): Promise<Phase[]> { return PHASES; } } as unknown as JobRepository,
    // The one write `advance_thread` makes on a thread row: HOW the caller closed. It reads none —
    // it never touches a thread it was not handed — and it raises no proposal, so the transition
    // repository below stays empty: a thread boundary is not a human boundary.
    {
      async recordOutcome(outcome: {
        threadId: string;
        condition: string;
        resolution?: string;
      }): Promise<void> {
        outcomes.push(outcome);
      },
    } as unknown as ThreadRepository,
    {} as unknown as TransitionRepository,
    {
      async closeThread(thread: Thread): Promise<void> {
        closed.push(thread.id);
      },
      async openThread(jobId: string, role: EThreadRole): Promise<Thread> {
        opened.push({ jobId, role });
        return SUCCESSOR;
      },
      async currentSession(): Promise<EngineSession> {
        return { id: 'session-2', accountId: 'account-1' } as unknown as EngineSession;
      },
    } as unknown as SessionManagerService,
    {
      async forPhase(): Promise<{ instructions: string; opening: string }> {
        return { instructions: 'build instructions', opening: 'You are building.' };
      },
    } as unknown as PhaseBriefService,
    {
      list: (): ContextEntry[] => LISTING,
      resolveInside: (args: { relativePath: string }): string =>
        join(ROOT, args.relativePath),
    } as unknown as ContextFolderService,
    {
      async run(args: RunTurnArgs): Promise<void> {
        turns.push(args);
      },
    } as unknown as TurnRunnerService,
    fakeTaskService(),
    fakeShipService(),
    fakeServiceRegistry(),
  );

  const ctx: ToolContext = {
    job: JOB,
    thread: THREAD,
    phase: EPhaseKind.build,
    cwd: '/repo',
    tier: EToolTier.thread,
  };

  return { service, ctx, closed, opened, turns, outcomes };
}

describe('advance_thread', () => {
  it('closes the caller and opens exactly ONE successor, which becomes the job’s active thread', async () => {
    const { service, ctx, closed, opened, turns, outcomes } = build();

    await service.advanceThread({
      ctx,
      role: EThreadRole.builder,
      handoff: 'Slice 3 is done.',
      attach: [],
    });

    expect(closed).toEqual([THREAD.id]);
    // A closed row says HOW, and `handed_off` is Atlas's to stamp rather than the agent's to claim:
    // it is true because a successor exists. The hand-off is this thread's own last word.
    expect(outcomes).toEqual([
      {
        threadId: THREAD.id,
        condition: 'handed_off',
        resolution: 'Slice 3 is done.',
      },
    ]);
    // `openThread` is what stamps `Job.activeThreadId` — see `session-manager.spec.ts`. One call,
    // never a fan-out: the wave is dead and a successor is a successor.
    expect(opened).toEqual([{ jobId: JOB.id, role: EThreadRole.builder }]);
    expect(turns.length).toBe(1);
    expect(turns[0]?.thread.id).toBe(SUCCESSOR.id);
  });

  it('seeds the successor with the outgoing agent’s own words, as a hand-off', async () => {
    const { service, ctx, turns } = build();

    await service.advanceThread({
      ctx,
      role: EThreadRole.builder,
      handoff: 'Tried a shared cache and rejected it — the invalidation is per-job.',
      attach: [],
    });

    const seed = turns[0];
    expect(seed?.harnessVariant).toBe(EHarnessVariant.handoff);
    expect(seed?.prompt).toContain('Tried a shared cache and rejected it');
    // The phase's opening orients it; the phase's standing instructions ride the system prompt.
    expect(seed?.prompt).toContain('You are building.');
    expect(seed?.brief).toBe('build instructions');
    expect(seed?.cwd).toBe('/repo');
  });

  it('gives the successor the tools it will need to advance in its turn', async () => {
    const { service, ctx, turns } = build();

    await service.advanceThread({
      ctx,
      role: EThreadRole.builder,
      handoff: 'done',
      attach: [],
    });

    expect(turns[0]?.tools?.map((tool) => tool.name)).toEqual([
      'advance_thread',
      'advance_phase',
      'open_thread',
      'complete_thread',
      // The three task tools are here because the seam HOLDS a `TaskService` — the wiring is what
      // makes them exist at all, and a fixture that stopped passing one would make them vanish
      // silently rather than fail. That is what this assertion is for.
      'task_create',
      'task_update',
      'task_list',
      'rotate',
      // And the three service tools for the same reason: the seam HOLDS a `ServiceRegistryService`,
      // and that wiring is the only thing that makes them exist. They are ungated by phase — a
      // successor inherits the job's services and needs `service_list` to learn their ids.
      'service_start',
      'service_stop',
      'service_list',
    ]);
  });

  it('inlines the phase floor even when nothing is declared, and the declaration on top of it', async () => {
    const { service, ctx, turns } = build();

    const reply = await service.advanceThread({
      ctx,
      role: EThreadRole.builder,
      handoff: 'done',
      attach: ['specs/03-slice.md'],
    });

    // Asked of what the model RECEIVES, not of the prose: the bodies now ride the message's
    // attachment manifest and are composed onto the wire at send, so the prompt alone would answer
    // a different question than "was this successor handed the file?".
    const turn = turns[0];
    const prompt = renderPrompt(
      promptPayload({
        text: turn?.prompt ?? '',
        harnessVariant: turn?.harnessVariant,
        attachments: turn?.attachments,
      }),
    );
    // Unnumbered is everyone's, so it arrives whether or not the agent remembered it.
    expect(prompt).toContain('the plan, shared by everyone');
    expect(prompt).toContain('slice three, one thread’s');
    // Numbered and not declared: another thread's, and not this successor's business.
    expect(prompt).not.toContain('slice four, not attached');
    expect(reply).toContain('context/specs/03-slice.md');
  });

  it('tells the caller what it ignored rather than silently dropping it', async () => {
    const { service, ctx } = build();

    const reply = await service.advanceThread({
      ctx,
      role: EThreadRole.builder,
      handoff: 'done',
      attach: ['generated/handoff.md'],
    });

    expect(reply).toContain('ignored');
    expect(reply).toContain('generated/handoff.md');
  });

  it('refuses a role the phase does not host, and closes nothing when it does', async () => {
    const { service, ctx, closed, opened } = build();

    await expect(
      service.advanceThread({
        ctx,
        role: EThreadRole.planner,
        handoff: 'done',
        attach: [],
      }),
    ).rejects.toThrow('does not host');
    expect(closed).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe('the advance_thread tool', () => {
  it('offers exactly the roles the phase hosts — the schema is the rail, not a check afterwards', () => {
    const { service, ctx } = build();
    const tool = advanceThreadTool({ ctx, actions: service });

    expect(tool).not.toBeNull();
    const schema = z.object(tool?.shape ?? {});
    const call = { handoff: 'done', attach: [] };
    // `build` hosts one role. The enum is `PhaseSpec.roles`, so `build → planner` is something the
    // agent cannot emit rather than something it is told off for after the fact.
    expect(schema.safeParse({ ...call, role: EThreadRole.builder }).success).toBe(true);
    expect(schema.safeParse({ ...call, role: EThreadRole.planner }).success).toBe(false);
  });

  it('routes a parsed call straight through to the seam', async () => {
    const { service, ctx, closed, opened } = build();
    const tool = advanceThreadTool({ ctx, actions: service });

    const reply = await tool?.handler({
      role: EThreadRole.builder,
      handoff: 'done',
      attach: [],
    });

    expect(reply).toContain('This thread is closed');
    expect(closed).toEqual([THREAD.id]);
    expect(opened.length).toBe(1);
  });

  it('rejects a call the schema does not admit, without touching anything', async () => {
    const { service, ctx, closed } = build();
    const tool = advanceThreadTool({ ctx, actions: service });

    // `handoff` is required and `attach` is required — an empty array is a statement, an omission
    // is not, which is the whole reason it is not optional.
    await expect(tool?.handler({ role: EThreadRole.builder })).rejects.toThrow();
    expect(closed).toEqual([]);
  });
});
