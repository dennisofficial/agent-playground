import { describe, expect, it } from 'bun:test';
import type { Account, EngineSession, Phase, Thread } from '../../generated/prisma/client.js';
import {
  EAccountStatus,
  EPhaseKind,
  EThreadRole,
  type EEngine,
} from '../../generated/prisma/enums.js';
import { bindingFor, type EngineConfig } from '../../domain/role-engine.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { SessionRepository } from '../../store/session.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import { SessionManagerService } from '../session-manager.service.js';

const PHASE: Phase = {
  id: 'phase-2',
  jobId: 'job-1',
  kind: EPhaseKind.planning,
  title: null,
  ordinal: 1,
};

/**
 * The placement rule is the whole point: a thread joins the phase the JOB is in. There is no
 * role → phase table any more, so opening a `research` thread during planning must not conjure a
 * design phase to file it under.
 */
describe('SessionManagerService.openThread', () => {
  function build(): {
    sessionManagerService: SessionManagerService;
    created: { phaseId: string; role: EThreadRole }[];
    activeThreadIds: string[];
  } {
    const created: { phaseId: string; role: EThreadRole }[] = [];
    const activeThreadIds: string[] = [];

    const threadRepository = {
      async create(args: { phaseId: string; role: EThreadRole }): Promise<Thread> {
        created.push(args);
        return { id: 'thread-1', phaseId: args.phaseId, role: args.role } as unknown as Thread;
      },
    } as unknown as ThreadRepository;

    const jobRepository = {
      async currentPhase(): Promise<Phase> {
        return PHASE;
      },
      async setActiveThread(_jobId: string, threadId: string): Promise<void> {
        activeThreadIds.push(threadId);
      },
    } as unknown as JobRepository;

    const sessionManagerService = new SessionManagerService(
      threadRepository,
      {} as unknown as SessionRepository,
      {} as unknown as AccountRepository,
      jobRepository,
    );
    return { sessionManagerService, created, activeThreadIds };
  }

  it('puts a new thread in the job’s current phase, whatever its role', async () => {
    const { sessionManagerService, created } = build();

    await sessionManagerService.openThread('job-1', EThreadRole.research);

    expect(created).toEqual([{ phaseId: PHASE.id, role: EThreadRole.research }]);
  });

  it('moves the job’s cursor onto the thread it just opened', async () => {
    const { sessionManagerService, activeThreadIds } = build();

    const thread = await sessionManagerService.openThread('job-1', EThreadRole.charting);

    expect(activeThreadIds).toEqual([thread.id]);
  });
});

/**
 * The config is COPIED onto the row at open — not looked up per turn — so editing the role table
 * next month cannot retroactively rewrite what a session ran with. Effort is the field that makes
 * this matter: Codex takes it per turn, so a lookup would silently change mid-session.
 */
describe('SessionManagerService.openSession', () => {
  function buildForSession(role: EThreadRole): {
    sessionManagerService: SessionManagerService;
    thread: Thread;
    opened: { accountId: string; engineConfig: EngineConfig }[];
  } {
    const opened: { accountId: string; engineConfig: EngineConfig }[] = [];
    const thread = { id: 'thread-1', role } as unknown as Thread;

    const sessionRepository = {
      async open(args: { accountId: string; engineConfig: EngineConfig }): Promise<EngineSession> {
        opened.push(args);
        return { id: 'session-1' } as unknown as EngineSession;
      },
    } as unknown as SessionRepository;

    const accountRepository = {
      async listForEngine(engine: EEngine): Promise<Account[]> {
        return [
          { id: `${engine}-account`, status: EAccountStatus.active, fiveHourUtil: 10 },
        ] as unknown as Account[];
      },
    } as unknown as AccountRepository;

    const threadRepository = {
      async setActiveSession(): Promise<void> {},
    } as unknown as ThreadRepository;

    const sessionManagerService = new SessionManagerService(
      threadRepository,
      sessionRepository,
      accountRepository,
      {} as unknown as JobRepository,
    );
    return { sessionManagerService, thread, opened };
  }

  it('freezes the role’s whole engine config — model AND effort — onto the session', async () => {
    const { sessionManagerService, thread, opened } = buildForSession(EThreadRole.master_review);

    await sessionManagerService.openSession(thread);

    expect(opened[0]?.engineConfig).toEqual(bindingFor(EThreadRole.master_review).engine);
  });

  it('picks the account from the engine the role is bound to, not from the role', async () => {
    // The engine narrows the pool; the role plays no part beyond naming the engine.
    const { sessionManagerService, thread, opened } = buildForSession(EThreadRole.builder);

    await sessionManagerService.openSession(thread);

    expect(opened[0]?.accountId).toBe('claude-account');
  });
});
