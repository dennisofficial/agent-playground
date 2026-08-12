import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Phase, Project, Thread } from '../../generated/prisma/client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { MessageRepository } from '../../store/message.repository.js';
import type { ProjectRepository } from '../../store/project.repository.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { TransitionRepository } from '../../store/transition.repository.js';
import type { TurnRepository } from '../../store/turn.repository.js';
import type { AccountUsageService } from '../account-usage.service.js';
import type { ContextFolderService } from '../context-folder.service.js';
import { ConversationService } from '../conversation.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import type { GitService } from '../git.service.js';
import { JobStartService } from '../job-start.service.js';
import { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import { ThreadSeamService } from '../thread-seam.service.js';
import { fakeShipService } from './ship.fixture.js';
import { fakeTaskService } from './tasks.fixture.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';
import { WorkspaceService } from '../workspace.service.js';
import type { WorktreeService } from '../worktree.service.js';

/**
 * Creating a job from its first message.
 *
 * The whole ticket is in the shape of what comes out: one job, named after words the human already
 * typed, whose first thread's first turn is that same text sent as the human — no title prompt in
 * front of it and no harness seed above it in the transcript.
 *
 * `ConversationService` is REAL here rather than faked, because "nothing is seeded" is a claim
 * about turns and a seed is a turn: a seeding call site anywhere in this path would show up below
 * as a second turn carrying `harnessVariant: seed`, which a fake would have hidden.
 */

const JOB = {
  id: 'job-1',
  title: 'add avatar upload',
  branch: null,
  projectId: 'project-1',
} as unknown as Job;

const THREAD = { id: 'thread-1', phaseId: 'phase-1', role: EThreadRole.charting } as unknown as Thread;
const PHASES = [{ id: 'phase-1', kind: EPhaseKind.charting, ordinal: 0 } as unknown as Phase];
const SESSION = { id: 'session-1', accountId: 'account-1' } as unknown as EngineSession;

function build(run: (args: RunTurnArgs) => Promise<void> = async () => undefined) {
  const created: { title: string; projectId: string }[] = [];
  const openedRoles: EThreadRole[] = [];
  const contextFolders: string[] = [];
  const turns: RunTurnArgs[] = [];

  const jobRepository = {
    async create(args: { projectId: string; title: string }): Promise<Job> {
      created.push({ title: args.title, projectId: args.projectId });
      return JOB;
    },
    async findById(): Promise<Job> {
      return JOB;
    },
    async findWithProject(): Promise<Job & { project: Project }> {
      return { ...JOB, project: { path: '/repo' } as Project };
    },
    async listPhases(): Promise<Phase[]> {
      return PHASES;
    },
  } as unknown as JobRepository;

  const contextFolderService = {
    ensure: (jobId: string): string => {
      contextFolders.push(jobId);
      return '/atlas/jobs/job-1/context';
    },
  } as unknown as ContextFolderService;

  const turnRunnerService = {
    busy: (): boolean => false,
    async run(args: RunTurnArgs): Promise<void> {
      turns.push(args);
      await run(args);
    },
  } as unknown as TurnRunnerService;

  const sessionManagerService = {
    async currentSession(): Promise<EngineSession> {
      return SESSION;
    },
  } as unknown as SessionManagerService;

  // Real, not faked, for the same reason `ConversationService` is: a stray seed would fire a second
  // turn through this object, and a stub would have swallowed it.
  const threadSeamService = new ThreadSeamService(
    jobRepository,
    {} as unknown as ThreadRepository,
    {} as unknown as TransitionRepository,
    sessionManagerService,
    new PhaseBriefService(jobRepository, contextFolderService),
    contextFolderService,
    turnRunnerService,
    fakeTaskService(),
    fakeShipService(),
  );

  const conversationService = new ConversationService(
    jobRepository,
    {} as unknown as ThreadRepository,
    {
      async claim(): Promise<boolean> {
        return true;
      },
      async refsForThread(): Promise<[]> {
        return [];
      },
    } as unknown as SessionRepository,
    {
      async listForThread(): Promise<[]> {
        return [];
      },
    } as unknown as MessageRepository,
    {
      async lastForThread(): Promise<null> {
        return null;
      },
    } as unknown as TurnRepository,
    sessionManagerService,
    turnRunnerService,
    contextFolderService,
    { kick: (): void => undefined } as unknown as AccountUsageService,
    new PhaseBriefService(jobRepository, contextFolderService),
    threadSeamService,
    new ConversationStoreRegistry(),
  );

  const workspaceService = new WorkspaceService(
    {} as unknown as ProjectRepository,
    jobRepository,
    {} as unknown as ThreadRepository,
    {} as unknown as AccountRepository,
    {
      async openThread(_jobId: string, role: EThreadRole): Promise<Thread> {
        openedRoles.push(role);
        return THREAD;
      },
    } as unknown as SessionManagerService,
    contextFolderService,
    conversationService,
    { cwdFor: (): string => '/repo' } as unknown as WorktreeService,
    {} as unknown as GitService,
  );

  return {
    jobStartService: new JobStartService(workspaceService, jobRepository, conversationService),
    created,
    openedRoles,
    contextFolders,
    turns,
  };
}

describe('starting a job from its first message', () => {
  it('derives the title from what was typed rather than asking for one', async () => {
    const { jobStartService, created } = build();

    await jobStartService.start({
      projectId: 'project-1',
      firstMessage: 'add avatar upload\n\nit should resize to 512px and strip exif',
    });

    expect(created).toEqual([{ title: 'add avatar upload', projectId: 'project-1' }]);
  });

  it('opens exactly one generic thread, and the job’s context folder with it', async () => {
    const { jobStartService, openedRoles, contextFolders } = build();

    await jobStartService.start({ projectId: 'project-1', firstMessage: 'why is the build red' });

    // Generic: a job that is one question is met by a coding agent, not by one preparing to chart.
    expect(openedRoles).toEqual([EThreadRole.generic]);
    expect(contextFolders).toContain(JOB.id);
  });

  it('sends the first message AS the human, with no harness seed above it', async () => {
    const { jobStartService, turns } = build();

    await jobStartService.start({
      projectId: 'project-1',
      firstMessage: '  hey how does auth work?  ',
    });

    // ONE turn. A seed would be a second one, and it would carry a harness variant.
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn?.harnessVariant).toBeUndefined();
    expect(turn?.prompt).toBe('hey how does auth work?');
    expect(turn?.thread.id).toBe(THREAD.id);
    expect(turn?.cwd).toBe('/repo');
    // The phase's standing instructions still ride the system prompt — only the seed MESSAGE went.
    expect(turn?.brief).toContain('chart the way');
  });

  it('lands on the conversation without waiting for the turn', async () => {
    let started = false;
    const { jobStartService } = build(
      () =>
        new Promise<void>(() => {
          started = true;
        }),
    );

    // Resolves while the first turn is still running; an awaited `run()` would hang this test.
    const result = await jobStartService.start({
      projectId: 'project-1',
      firstMessage: 'ship the thing',
    });

    expect(started).toBe(true);
    expect(result.open.thread.id).toBe(THREAD.id);
    expect(result.cwd).toBe('/repo');
    expect(result.job.id).toBe(JOB.id);
  });

  it('creates nothing at all from an empty message', async () => {
    const { jobStartService, created, openedRoles, contextFolders, turns } = build();

    expect(
      jobStartService.start({ projectId: 'project-1', firstMessage: '   \n\t ' }),
    ).rejects.toThrow(/starts with a message/);

    expect(created).toEqual([]);
    expect(openedRoles).toEqual([]);
    expect(contextFolders).toEqual([]);
    expect(turns).toEqual([]);
  });
});
