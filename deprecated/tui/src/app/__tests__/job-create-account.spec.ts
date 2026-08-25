import { describe, expect, it, mock } from 'bun:test';
import { EAccountStatus, EEngine, EThreadRole } from '../../generated/prisma/enums.js';
import type { Account, Job, Thread } from '../../generated/prisma/client.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ProjectRepository } from '../../store/project.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { ContextFolderService } from '../context-folder.service.js';
import type { ConversationService } from '../conversation.service.js';
import type { GitService } from '../git.service.js';
import { SessionManagerService } from '../session-manager.service.js';
import { fakeServiceRegistry } from './services.fixture.js';
import { WorkspaceService } from '../workspace.service.js';
import type { WorktreeService } from '../worktree.service.js';

/**
 * Creating a job does not depend on having a credential.
 *
 * It used to throw when the first turn opened its session — after `createJob` had written a job row, a
 * phase, a thread, a context folder on disk and possibly a git worktree — so an unusable account left
 * a permanent empty job behind. Guarding creation instead would have refused work over something one
 * keypress fixes. Now `EngineSession.accountId` is nullable: the job is created, the session holds no
 * account, and the conversation says so until one exists.
 */
function build(accounts: Partial<Account>[]) {
  const created: string[] = [];
  // Filters by engine, as the real repository does: the pool is per engine, and a codex account is
  // not a claude one however healthy it looks.
  const accountRepository = {
    listForEngine: mock(async (engine: EEngine) =>
      accounts
        .map(
          (account) =>
            ({
              engine: EEngine.claude,
              status: EAccountStatus.active,
              fiveHourUtil: null,
              fiveHourResetsAt: null,
              ...account,
            }) as unknown as Account,
        )
        .filter((account) => account.engine === engine),
    ),
  } as unknown as AccountRepository;

  const jobRepository = {
    create: mock(async (args: { title: string }) => {
      created.push(args.title);
      return { id: 'job-1', title: args.title } as unknown as Job;
    }),
    findById: mock(async () => ({ id: 'job-1' }) as unknown as Job),
    setActiveThread: mock(async () => undefined),
    currentPhase: mock(async () => ({ id: 'phase-1' })),
  } as unknown as JobRepository;

  const threadRepository = {
    create: mock(async () => ({ id: 'thread-1' }) as unknown as Thread),
  } as unknown as ThreadRepository;

  const sessionManagerService = new SessionManagerService(
    threadRepository,
    {} as never,
    accountRepository,
    jobRepository,
  );

  const contextFolders: string[] = [];
  const workspaceService = new WorkspaceService(
    {} as unknown as ProjectRepository,
    jobRepository,
    threadRepository,
    accountRepository,
    sessionManagerService,
    {
      ensure: (jobId: string): void => {
        contextFolders.push(jobId);
      },
    } as unknown as ContextFolderService,
    {} as unknown as ConversationService,
    {} as unknown as WorktreeService,
    {} as unknown as GitService,
    fakeServiceRegistry(),
  );

  return { workspaceService, created, contextFolders };
}

describe('WorkspaceService.createJob without an account', () => {
  it('creates the job anyway — it is idle, not broken', async () => {
    const { workspaceService, created, contextFolders } = build([]);

    const { job } = await workspaceService.createJob({
      projectId: 'project-1',
      title: 'add avatar upload',
    });

    expect(job.id).toBe('job-1');
    expect(created).toEqual(['add avatar upload']);
    // The folder too: everything a job is made of exists, and only the turn waits.
    expect(contextFolders).toEqual(['job-1']);
  });

  it('creates the job when there is an account to run it on', async () => {
    const { workspaceService, created } = build([{ id: 'a' }]);

    const { job } = await workspaceService.createJob({
      projectId: 'project-1',
      title: 'add avatar upload',
    });

    expect(job.id).toBe('job-1');
    expect(created).toEqual(['add avatar upload']);
  });

  it('accepts an expired account — the refresh on the turn path is what decides it', async () => {
    const { workspaceService, created } = build([
      { id: 'dead', status: EAccountStatus.expired },
    ]);

    await workspaceService.createJob({ projectId: 'project-1', title: 'x' });

    expect(created).toEqual(['x']);
  });
});

/**
 * Not a gate on creation — the nudge that sends someone to the accounts page BEFORE they type a
 * paragraph into a job that cannot answer it. It asks about the engine the first thread will bind to,
 * which is what counting rows failed to do.
 */
describe('WorkspaceService.hasAccount', () => {
  it('reports usable, not merely present — an unusable account is what the UI diverts on', async () => {
    const { workspaceService } = build([{ id: 'gone', status: EAccountStatus.revoked }]);

    expect(await workspaceService.hasAccount(EThreadRole.generic)).toBe(false);
  });

  it('reports true for an expired account, which a refresh may still heal', async () => {
    const { workspaceService } = build([{ id: 'dead', status: EAccountStatus.expired }]);

    expect(await workspaceService.hasAccount(EThreadRole.generic)).toBe(true);
  });

  it('does not count another engine’s account as this thread’s', async () => {
    const { workspaceService } = build([{ id: 'a', engine: EEngine.codex }]);

    expect(await workspaceService.hasAccount(EThreadRole.generic)).toBe(false);
  });
});
