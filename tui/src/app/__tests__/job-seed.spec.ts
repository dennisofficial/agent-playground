import { describe, expect, it } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { EngineSession, Job, Phase, Project, Thread } from '../../generated/prisma/client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ProjectRepository } from '../../store/project.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { AccountUsageService } from '../account-usage.service.js';
import type { ContextFolderService } from '../context-folder.service.js';
import { ConversationService } from '../conversation.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import type { GitService } from '../git.service.js';
import type { MessageRepository } from '../../store/message.repository.js';
import { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { TurnRepository } from '../../store/turn.repository.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';
import { WorkspaceService } from '../workspace.service.js';
import type { WorktreeService } from '../worktree.service.js';

/**
 * A new job must not open onto a blank conversation. These two tests are the whole seam: the phase
 * table supplies the words, and creating a job fires them into the intake thread as Atlas rather
 * than as the human.
 */

const JOB = {
  id: 'job-1',
  title: 'add avatar upload',
  branch: null,
  projectId: 'project-1',
} as unknown as Job;

const THREAD = { id: 'thread-1', phaseId: 'phase-1', role: EThreadRole.intake } as unknown as Thread;

const PHASES = [
  { id: 'phase-1', kind: EPhaseKind.intake, ordinal: 0 } as unknown as Phase,
];

function briefService(): PhaseBriefService {
  return new PhaseBriefService(
    { async listPhases(): Promise<Phase[]> { return PHASES; } } as unknown as JobRepository,
    { ensure: (): string => '/atlas/jobs/job-1/context' } as unknown as ContextFolderService,
  );
}

function conversation(run: (args: RunTurnArgs) => Promise<void>) {
  const service = new ConversationService(
    {} as unknown as JobRepository,
    {} as unknown as ThreadRepository,
    {} as unknown as SessionRepository,
    {} as unknown as MessageRepository,
    {} as unknown as TurnRepository,
    {
      async currentSession(): Promise<EngineSession> {
        return { id: 'session-1', accountId: 'account-1' } as unknown as EngineSession;
      },
    } as unknown as SessionManagerService,
    { run } as unknown as TurnRunnerService,
    { ensure: (): string => '/atlas/jobs/job-1/context' } as unknown as ContextFolderService,
    { kick: (): void => undefined } as unknown as AccountUsageService,
    briefService(),
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

    const workspace = new WorkspaceService(
      {} as unknown as ProjectRepository,
      {
        async create(): Promise<Job> {
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
      { cwdFor: (): string => '/repo' } as unknown as WorktreeService,
      {} as unknown as GitService,
    );

    return { workspace, seeded, opened };
  }

  it('opens one intake thread and seeds it', async () => {
    const { workspace, seeded, opened } = build();

    await workspace.createJob({ projectId: 'project-1', title: 'add avatar upload' });

    expect(opened).toEqual([EThreadRole.intake]);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.thread.id).toBe(THREAD.id);
    // The turn runs where the job's work runs — its worktree if it took one, else the project path.
    expect(seeded[0]?.cwd).toBe('/repo');
  });
});
