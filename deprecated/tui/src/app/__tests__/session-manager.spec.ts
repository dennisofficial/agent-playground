import { describe, expect, it } from 'bun:test';
import type { Account, EngineSession, Phase, Thread } from '../../generated/prisma/client.js';
import {
  EAccountStatus,
  EEngine,
  EPhaseKind,
  EThreadRole,
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

/**
 * Which account a session opens on, and what is said when none can be.
 *
 * The message matters as much as the choice: this is the error a human meets when a job will not
 * start, and "no usable claude account" told them neither what happened nor what to do about it. It
 * was also reached far too easily — a single hard refresh failure marked the account `expired`, and
 * `expired` was filtered out here with nothing anywhere to put it back.
 */
describe('SessionManagerService account selection', () => {
  function buildWith(accounts: Partial<Account>[]): SessionManagerService {
    const accountRepository = {
      async listForEngine(): Promise<Account[]> {
        return accounts.map(
          (account) =>
            ({
              status: EAccountStatus.active,
              fiveHourUtil: null,
              fiveHourResetsAt: null,
              ...account,
            }) as unknown as Account,
        );
      },
    } as unknown as AccountRepository;

    return new SessionManagerService(
      { async setActiveSession(): Promise<void> {} } as unknown as ThreadRepository,
      {
        async open(args: { accountId: string | null }): Promise<EngineSession> {
          return { id: 'session-1', accountId: args.accountId } as unknown as EngineSession;
        },
      } as unknown as SessionRepository,
      accountRepository,
      {} as unknown as JobRepository,
    );
  }

  const thread = { id: 'thread-1', role: EThreadRole.generic } as unknown as Thread;

  it('runs on an expired account rather than refusing — the refresh will heal it or say why', async () => {
    const manager = buildWith([{ id: 'dead', status: EAccountStatus.expired }]);

    const session = await manager.openSession(thread);

    expect(session.accountId).toBe('dead');
  });

  /**
   * The shape this replaced threw instead — from inside job creation, over a job row, a phase, a
   * thread and a context folder that were already written. A session holding no credential is a state
   * the schema can express and the conversation can render, so opening one is not a failure.
   */
  it('opens a session with NO account rather than refusing to open one', async () => {
    const manager = buildWith([]);

    const session = await manager.openSession(thread);

    expect(session.accountId).toBeNull();
  });

  it('reports no usable account as null, not as a throw', async () => {
    const manager = buildWith([{ id: 'gone', status: EAccountStatus.revoked }]);

    expect(await manager.usableAccount(EEngine.claude)).toBeNull();
  });

  it('hands out the sentence for whoever has to show the state', async () => {
    // The three situations and their wording are pinned in `domain/__tests__/rotation.spec.ts`; this
    // only asserts the service asks about the right engine's pool.
    const manager = buildWith([{ id: 'gone', status: EAccountStatus.revoked }]);

    expect(await manager.whyNoAccount(EEngine.claude)).toMatch(/claude/);
  });
});

/**
 * A `Thread` in hand is a SNAPSHOT, and this is what happens when it is trusted.
 *
 * Every path that opens a thread and then seeds it returns the row it created — captured before the
 * seeding turn opened session 1 — and the UI carries that copy into `loadConversation`, which asks
 * for the current session. Minting from the snapshot opened a SECOND session on a thread that
 * already had one, and it showed up twice: the transcript grew a `session 2 · previous leg ended`
 * divider nobody had rotated through (`withSeams` derives a seam from exactly that disagreement),
 * and the human's first message ran on an engine session that had never seen the seed turn.
 */
describe('SessionManagerService.currentSession', () => {
  function buildForCurrent(args: {
    /** What the caller is HOLDING — the row as it was when they got it. */
    held: string | null;
    /** What the row says NOW. */
    stored: string | null;
    /** Sessions the store knows about, and whether each has ended. */
    sessions: { id: string; endedAt: Date | null }[];
  }): { manager: SessionManagerService; opened: string[] } {
    const opened: string[] = [];

    const sessionRepository = {
      async findById(id: string): Promise<EngineSession | null> {
        const found = args.sessions.find((session) => session.id === id);
        return found ? ({ ...found, accountId: null } as unknown as EngineSession) : null;
      },
      async open(): Promise<EngineSession> {
        const id = `session-${args.sessions.length + opened.length + 1}`;
        opened.push(id);
        return { id, accountId: null } as unknown as EngineSession;
      },
    } as unknown as SessionRepository;

    const threadRepository = {
      async findById(): Promise<Thread> {
        return { id: 'thread-1', activeSessionId: args.stored } as unknown as Thread;
      },
      async setActiveSession(): Promise<void> {},
    } as unknown as ThreadRepository;

    const manager = new SessionManagerService(
      threadRepository,
      sessionRepository,
      {
        async listForEngine(): Promise<Account[]> {
          return [];
        },
      } as unknown as AccountRepository,
      {} as unknown as JobRepository,
    );
    return { manager, opened };
  }

  const stale = { id: 'thread-1', activeSessionId: null, role: EThreadRole.task } as unknown as Thread;

  it('finds the session a stale row does not know about, instead of minting a second', async () => {
    const { manager, opened } = buildForCurrent({
      held: null,
      stored: 'session-1',
      sessions: [{ id: 'session-1', endedAt: null }],
    });

    const session = await manager.currentSession(stale);

    expect(session.id).toBe('session-1');
    expect(opened).toEqual([]);
  });

  it('still opens the first session on a thread that genuinely has none', async () => {
    const { manager, opened } = buildForCurrent({ held: null, stored: null, sessions: [] });

    const session = await manager.currentSession(stale);

    expect(session.id).toBe('session-1');
    expect(opened).toEqual(['session-1']);
  });

  // The same statement covers a snapshot taken before a ROTATION — the pointer resolves to a leg
  // that has ended, so it is re-read rather than treated as "no session".
  it('follows a rotation the held row predates', async () => {
    const preRotation = {
      id: 'thread-1',
      activeSessionId: 'session-1',
      role: EThreadRole.task,
    } as unknown as Thread;
    const { manager, opened } = buildForCurrent({
      held: 'session-1',
      stored: 'session-2',
      sessions: [
        { id: 'session-1', endedAt: new Date(0) },
        { id: 'session-2', endedAt: null },
      ],
    });

    const session = await manager.currentSession(preRotation);

    expect(session.id).toBe('session-2');
    expect(opened).toEqual([]);
  });

  it('opens a fresh leg when the row’s own pointer is an ended session', async () => {
    const ended = {
      id: 'thread-1',
      activeSessionId: 'session-1',
      role: EThreadRole.task,
    } as unknown as Thread;
    const { manager, opened } = buildForCurrent({
      held: 'session-1',
      stored: 'session-1',
      sessions: [{ id: 'session-1', endedAt: new Date(0) }],
    });

    await manager.currentSession(ended);

    expect(opened).toEqual(['session-2']);
  });
});
