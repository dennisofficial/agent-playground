import { describe, expect, it } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Phase, Project, Thread } from '../../generated/prisma/client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ProjectRepository } from '../../store/project.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { TransitionRepository } from '../../store/transition.repository.js';
import type { AccountUsageService } from '../account-usage.service.js';
import type { ContextFolderService } from '../context-folder.service.js';
import { ConversationService } from '../conversation.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import type { GitService } from '../git.service.js';
import type { MessageRepository } from '../../store/message.repository.js';
import { PhaseBriefService } from '../phase-brief.service.js';
import { ThreadSeamService } from '../thread-seam.service.js';
import { fakePullRequestService } from './pull-request.fixture.js';
import { fakeServiceRegistry } from './services.fixture.js';
import { fakeWorktreeService } from './worktree.fixture.js';
import { fakeTaskService } from './tasks.fixture.js';
import type { SessionManagerService } from '../session-manager.service.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { TurnRepository } from '../../store/turn.repository.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';
import { WorkspaceService } from '../workspace.service.js';
import type { WorktreeService } from '../worktree.service.js';

/**
 * A new job must not open onto a blank conversation. These two tests are the whole seam: the phase
 * table supplies the words, and creating a job fires them into the charting thread as Atlas rather
 * than as the human.
 */

const JOB = {
  id: 'job-1',
  title: 'add avatar upload',
  branch: null,
  projectId: 'project-1',
} as unknown as Job;

const THREAD = { id: 'thread-1', phaseId: 'phase-1', role: EThreadRole.charting } as unknown as Thread;

const PHASES = [
  { id: 'phase-1', kind: EPhaseKind.charting, ordinal: 0 } as unknown as Phase,
];

const JOB_REPOSITORY = {
  async listPhases(): Promise<Phase[]> {
    return PHASES;
  },
} as unknown as JobRepository;

const CONTEXT_FOLDER = {
  ensure: (): string => '/atlas/jobs/job-1/context',
} as unknown as ContextFolderService;

function briefService(): PhaseBriefService {
  return new PhaseBriefService(JOB_REPOSITORY, CONTEXT_FOLDER);
}

function conversation(run: (args: RunTurnArgs) => Promise<void>) {
  const sessionManagerService = {
    async currentSession(): Promise<EngineSession> {
      return { id: 'session-1', accountId: 'account-1' } as unknown as EngineSession;
    },
  } as unknown as SessionManagerService;
  const turnRunnerService = { run } as unknown as TurnRunnerService;

  const service = new ConversationService(
    {} as unknown as JobRepository,
    {} as unknown as ThreadRepository,
    {} as unknown as SessionRepository,
    {} as unknown as MessageRepository,
    {} as unknown as TurnRepository,
    sessionManagerService,
    turnRunnerService,
    CONTEXT_FOLDER,
    { kick: (): void => undefined } as unknown as AccountUsageService,
    briefService(),
    new ThreadSeamService(
      JOB_REPOSITORY,
      {} as unknown as ThreadRepository,
      {} as unknown as TransitionRepository,
      sessionManagerService,
      briefService(),
      CONTEXT_FOLDER,
      turnRunnerService,
      fakeTaskService(),
      fakePullRequestService(),
      fakeServiceRegistry(),
      fakeWorktreeService(),
  ),
    new ConversationStoreRegistry(),
  );
  return service;
}

describe('seeding a thread', () => {
  it('fires the phase’s opening words as a harness seed, with its instructions on the system prompt', async () => {
    const fired: RunTurnArgs[] = [];
    const service = conversation(async (args) => {
      fired.push(args);
    });

    await service.seedThread({ job: JOB, thread: THREAD, cwd: '/repo' });

    const turn = fired[0];
    expect(turn).toBeDefined();
    expect(turn?.harnessVariant).toBe(EHarnessVariant.seed);
    // The opening is what the transcript shows; the instructions are what every turn is told.
    expect(turn?.prompt).toContain('add avatar upload');
    expect(turn?.brief).toContain('chart the way');
    expect(turn?.prompt).not.toBe(turn?.brief);
    expect(turn?.cwd).toBe('/repo');
    expect(turn?.thread.id).toBe(THREAD.id);
  });

  it('does not wait for the turn — creating a job must not block behind an agent thinking', async () => {
    let started = false;
    const service = conversation(
      () =>
        new Promise<void>(() => {
          started = true;
        }),
    );

    // Resolves while the turn is still running; a `run()` awaited here would hang this test.
    await service.seedThread({ job: JOB, thread: THREAD, cwd: '/repo' });
    expect(started).toBe(true);
  });
});

describe('creating a job', () => {
  function build() {
    const seeded: { job: Job; thread: Thread; cwd: string }[] = [];
    const opened: EThreadRole[] = [];
    const adopted: { branch: string; workspacePath: string }[] = [];
    const entered: string[] = [];

    const workspace = new WorkspaceService(
      {} as unknown as ProjectRepository,
      {
        async create(): Promise<Job> {
          return JOB;
        },
        async findById(): Promise<Job> {
          return JOB;
        },
        async findWithProject(): Promise<Job & { project: Project }> {
          return { ...JOB, project: { path: '/repo' } as Project };
        },
      } as unknown as JobRepository,
      {} as unknown as ThreadRepository,
      {} as unknown as AccountRepository,
      {
        async openThread(_jobId: string, role: EThreadRole): Promise<Thread> {
          opened.push(role);
          return THREAD;
        },
      } as unknown as SessionManagerService,
      { ensure: (): string => '/atlas/jobs/job-1/context' } as unknown as ContextFolderService,
      {
        async seedThread(args: { job: Job; thread: Thread; cwd: string }): Promise<void> {
          seeded.push(args);
        },
      } as unknown as ConversationService,
      {
        cwdFor: (): string => '/repo',
        async adopt(args: { branch: string; workspacePath: string }): Promise<void> {
          adopted.push({ branch: args.branch, workspacePath: args.workspacePath });
        },
        async enter(args: { job: Job }): Promise<void> {
          entered.push(args.job.id);
        },
      } as unknown as WorktreeService,
      {} as unknown as GitService,
      fakeServiceRegistry(),
    );

    return { workspace, seeded, opened, adopted, entered };
  }

  it('opens one generic thread and seeds NOTHING — the human speaks first in a job', async () => {
    const { workspace, seeded, opened } = build();

    const { job, thread } = await workspace.createJob({
      projectId: 'project-1',
      title: 'add avatar upload',
    });

    // `generic`, not `charting`: the stance is earned by the work rather than assumed at creation,
    // and a job that is one question should not be met by an agent preparing to chart a map.
    expect(opened).toEqual([EThreadRole.generic]);
    // The first thread of a job opens on the human's own words — see `job-start.spec.ts`. Seeding
    // here would put a brief above them in the transcript and start the job in a posture.
    expect(seeded).toEqual([]);
    // The thread comes back with the job because the caller opens the conversation on it directly:
    // the job row was read before `openThread` stamped `activeThreadId` onto it.
    expect(job.id).toBe(JOB.id);
    expect(thread.id).toBe(THREAD.id);
  });

  /**
   * The fourth door onto a branch. `worktree: true` MINTS one and names it `atlas/…`; `adopt` stands
   * the job in a tree that was already there, on a branch somebody else named.
   */
  it('adopts an existing worktree instead of minting one', async () => {
    const { workspace, adopted, entered } = build();

    await workspace.createJob({
      projectId: 'project-1',
      title: 'risk matrix',
      adopt: { branch: 'dennis/eng-203', workspacePath: '/repo/.worktrees/eng-203' },
    });

    expect(adopted).toEqual([
      { branch: 'dennis/eng-203', workspacePath: '/repo/.worktrees/eng-203' },
    ]);
    // Not both. Minting a second worktree for a job that was handed one is the bug this door exists
    // to avoid, and `enter()` would have named it `atlas/risk-matrix`.
    expect(entered).toEqual([]);
  });

  it('takes adoption over `worktree: true` when a caller passes both', async () => {
    // A caller naming a specific worktree has already answered the question `worktree: true` asks.
    const { workspace, adopted, entered } = build();

    await workspace.createJob({
      projectId: 'project-1',
      title: 'risk matrix',
      worktree: true,
      adopt: { branch: 'dennis/eng-203', workspacePath: '/repo/.worktrees/eng-203' },
    });

    expect(adopted).toHaveLength(1);
    expect(entered).toEqual([]);
  });

  it('mints one when asked for a worktree with nothing to adopt', async () => {
    const { workspace, adopted, entered } = build();
    await workspace.createJob({ projectId: 'project-1', title: 'x', worktree: true });
    expect(adopted).toEqual([]);
    expect(entered).toEqual(['job-1']);
  });
});
