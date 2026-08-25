import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EToolTier } from '../../domain/tool-surface.js';
import {
  EPhaseKind,
  EThreadRole,
  EThreadStatus,
  ETransitionStatus,
} from '../../generated/prisma/enums.js';
import type {
  EngineSession,
  Job,
  Phase,
  Thread,
  Transition,
} from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type {
  TransitionRepository,
  TransitionRow,
} from '../../store/transition.repository.js';
import type { ContextEntry, ContextFolderService } from '../context-folder.service.js';
import { HumanVerbsService } from '../human-verbs.service.js';
import type { PhaseBriefService } from '../phase-brief.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import { ThreadSeamService } from '../thread-seam.service.js';
import { fakePullRequestService } from './pull-request.fixture.js';
import { fakeServiceRegistry } from './services.fixture.js';
import { fakeWorktreeService } from './worktree.fixture.js';
import { fakeTaskService } from './tasks.fixture.js';
import type { ToolContext } from '../tools/tool.js';
import type { RunTurnArgs, TurnRunnerService } from '../turn-runner.service.js';

/**
 * One job, one phase, one open thread — and everything `advance_phase` touches, faked except the
 * decisions. Shared by the two specs that use it because the fixture is the expensive half: what
 * they assert differs, what a phase transition needs to move does not.
 */

export const JOB = { id: 'job-1', title: 'add avatar upload', branch: null } as unknown as Job;

const ROOTS: string[] = [];

/**
 * A real folder with real files: the floor is computed from a listing and the bodies are inlined
 * from disk, and a fake filesystem would have proved only that the fake works. One per world rather
 * than one per module, so two spec files sharing this cannot delete each other's.
 */
function contextRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atlas-advance-phase-'));
  mkdirSync(join(root, 'specs'), { recursive: true });
  mkdirSync(join(root, 'charting'), { recursive: true });
  writeFileSync(join(root, 'specs', 'plan.md'), 'the plan, shared by every builder');
  writeFileSync(join(root, 'specs', '02-slice.md'), 'slice two, one thread’s');
  writeFileSync(join(root, 'charting', 'map.md'), 'the map, charting’s own');
  ROOTS.push(root);
  return root;
}

/** Call from `afterAll`. Idempotent, so it does not matter which spec ran first. */
export function cleanupWorlds(): void {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
}

const LISTING: ContextEntry[] = (
  [
    { bucket: 'specs', path: 'plan.md' },
    { bucket: 'specs', path: '02-slice.md' },
    { bucket: 'charting', path: 'map.md' },
  ] satisfies Pick<ContextEntry, 'bucket' | 'path'>[]
).map((entry) => ({
  ...entry,
  bytes: 1,
  modifiedAt: new Date(0),
  isDirectory: false,
}));

export function world(args: { phase?: EPhaseKind; role?: EThreadRole } = {}) {
  const kind = args.phase ?? EPhaseKind.planning;
  const root = contextRoot();
  const phases: Phase[] = [
    { id: 'phase-1', jobId: JOB.id, kind, title: null, ordinal: 0 } as unknown as Phase,
  ];
  const threads: Thread[] = [
    {
      id: 'thread-1',
      phaseId: 'phase-1',
      role: args.role ?? EThreadRole.planner,
      status: EThreadStatus.active,
      openedByThreadId: null,
      createdAt: new Date(0),
    } as unknown as Thread,
  ];
  const rows: TransitionRow[] = [];
  const turns: RunTurnArgs[] = [];
  const closed: string[] = [];
  const outcomes: { threadId: string; condition: string; resolution?: string }[] = [];
  /** Where `Job.activeThreadId` has been pointed. The human verbs move it; the agent's do too. */
  const cursor: string[] = [];
  /** Threads whose in-flight turn was cut. Only the human close does this. */
  const interrupted: string[] = [];

  const jobRepository = {
    async listPhases(): Promise<Phase[]> {
      return phases;
    },
    async findById(): Promise<Job> {
      return JOB;
    },
    // Phases are appended and never reopened, so the highest ordinal IS the current one.
    async currentPhase(): Promise<Phase> {
      const current = phases[phases.length - 1];
      if (!current) throw new Error('no phase');
      return current;
    },
    async setActiveThread(_jobId: string, threadId: string): Promise<void> {
      cursor.push(threadId);
    },
    async openThreadIdsInPhase(phaseId: string): Promise<string[]> {
      return threads
        .filter((t) => t.phaseId === phaseId && t.status !== EThreadStatus.closed)
        .map((t) => t.id);
    },
    async appendPhase(add: { jobId: string; kind: EPhaseKind }): Promise<Phase> {
      const phase = {
        id: `phase-${phases.length + 1}`,
        jobId: add.jobId,
        kind: add.kind,
        title: null,
        ordinal: phases.length,
      } as unknown as Phase;
      phases.push(phase);
      return phase;
    },
  } as unknown as JobRepository;

  const threadRepository = {
    async findById(id: string): Promise<Thread | null> {
      return threads.find((t) => t.id === id) ?? null;
    },
    // Rows rather than ids — the cursor rule needs each candidate's opener and age.
    async openInPhase(phaseId: string): Promise<Thread[]> {
      return threads.filter(
        (t) => t.phaseId === phaseId && t.status !== EThreadStatus.closed,
      );
    },
    // A confirmed transition closes the proposer, and every close path stamps HOW — `phase_advanced`
    // here, since the phase moved and took the work with it.
    async recordOutcome(outcome: {
      threadId: string;
      condition: string;
      resolution?: string;
    }): Promise<void> {
      outcomes.push(outcome);
    },
  } as unknown as ThreadRepository;

  const transitionRepository = {
    async raise(raised: Omit<TransitionRow, keyof Transition> & Record<string, unknown>) {
      const row = {
        ...raised,
        id: `transition-${rows.length + 1}`,
        scope: 'phase',
        raisedBy: 'agent',
        status: ETransitionStatus.pending,
        createdPhaseId: null,
        declineReason: null,
        decidedAt: null,
        createdAt: new Date(),
      } as unknown as TransitionRow;
      rows.push(row);
      return row;
    },
    async findById(id: string): Promise<TransitionRow | null> {
      return rows.find((row) => row.id === id) ?? null;
    },
    async pendingForJob(): Promise<TransitionRow[]> {
      return rows.filter((row) => row.status === ETransitionStatus.pending);
    },
    async confirm(decided: { id: string; createdPhaseId: string }): Promise<void> {
      const index = rows.findIndex((row) => row.id === decided.id);
      const row = rows[index];
      if (!row) return;
      rows[index] = {
        ...row,
        status: ETransitionStatus.confirmed,
        createdPhaseId: decided.createdPhaseId,
        decidedAt: new Date(),
      };
    },
    async decline(decided: { id: string; reason?: string }): Promise<void> {
      const index = rows.findIndex((row) => row.id === decided.id);
      const row = rows[index];
      if (!row) return;
      rows[index] = {
        ...row,
        status: ETransitionStatus.declined,
        declineReason: decided.reason ?? null,
        decidedAt: new Date(),
      };
    },
  } as unknown as TransitionRepository;

  const sessionManagerService = {
    async closeThread(thread: Thread): Promise<void> {
      closed.push(thread.id);
      const index = threads.findIndex((t) => t.id === thread.id);
      const found = threads[index];
      if (found) threads[index] = { ...found, status: EThreadStatus.closed };
    },
    // Mirrors the real one: a new thread joins the job's CURRENT phase, which is the highest
    // ordinal — so where it lands is a claim this test can actually make.
    async openThread(_jobId: string, role: EThreadRole): Promise<Thread> {
      const current = phases[phases.length - 1];
      const thread = {
        id: `thread-${threads.length + 1}`,
        phaseId: current?.id ?? 'phase-1',
        role,
        status: EThreadStatus.active,
        openedByThreadId: null,
        createdAt: new Date(threads.length + 1),
      } as unknown as Thread;
      threads.push(thread);
      cursor.push(thread.id);
      return thread;
    },
    async currentSession(): Promise<EngineSession> {
      return { id: 'session-2', accountId: 'account-1' } as unknown as EngineSession;
    },
  } as unknown as SessionManagerService;

  const turnRunnerService = {
    async run(run: RunTurnArgs): Promise<void> {
      turns.push(run);
    },
    async interrupt(threadId: string): Promise<void> {
      interrupted.push(threadId);
    },
  } as unknown as TurnRunnerService;

  const service = new ThreadSeamService(
    jobRepository,
    threadRepository,
    transitionRepository,
    sessionManagerService,
    {
      async forPhase(): Promise<{ instructions: string; opening: string }> {
        return { instructions: 'phase instructions', opening: 'Here is where you are.' };
      },
    } as unknown as PhaseBriefService,
    {
      list: (): ContextEntry[] => LISTING,
      resolveInside: (ref: { relativePath: string }): string => join(root, ref.relativePath),
    } as unknown as ContextFolderService,
    turnRunnerService,
    fakeTaskService(),
    fakePullRequestService(),
    fakeServiceRegistry(),
    fakeWorktreeService(),
  );

  /**
   * The human's verbs over the SAME fakes, so a spec can assert that starting a phase by hand and
   * confirming a proposal write the identical rows — which is the whole point of `enterPhase` being
   * one function.
   */
  const humanVerbs = new HumanVerbsService(
    jobRepository,
    threadRepository,
    sessionManagerService,
    service,
    turnRunnerService,
  );

  const firstThread = threads[0] as Thread;
  const ctx: ToolContext = {
    job: JOB,
    thread: firstThread,
    phase: kind,
    cwd: '/repo',
    tier: EToolTier.thread,
  };

  return {
    service,
    humanVerbs,
    ctx,
    phases,
    threads,
    rows,
    turns,
    closed,
    outcomes,
    cursor,
    interrupted,
  };
}

