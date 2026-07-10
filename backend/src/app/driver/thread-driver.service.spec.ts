import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import { EngineAuthError, EngineSessionLimitError } from '../engine';
import type { EngineRunnerPort, ToolBridgeOptions } from '../engine';
import {
  ThreadDriver,
  shortReason,
  renderCompletionMd,
} from './thread-driver.service';
import { BuildShipService } from './build-ship.service';
import type {
  DriverStoreService,
  DriverThread,
  JobRoute,
} from './driver-store.service';
import type { PlannedStep } from './render-plan';
import type { DriverRepoResolver, ResolvedRepo } from './repo-resolver';
import type { PlanVisibilityService } from '../decision-gate';
import type { AutoFixStage } from '../autofix';
import type {
  GithubPrService,
  LocalGitService,
  FeatureSandbox,
  ProjectRepo,
} from '../git';
import type { TurnRunnerService } from '../runner';
import type { BlockSink, ChatSurface, LiveTurnStore, TaskEventSink } from '../surface';
import { TurnHarnessFactory } from '../surface';
import type { CredentialResolver } from '../onboarding';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import type { LeaderElectionService } from '../cluster';
import type { EnvService } from '@core/config/env/env.service';
import type {
  DecisionRecord,
  Step,
  StepStatus,
  Thread,
  ThreadStatus,
  ThreadCondition,
  Job,
} from '../domain';
import type { TaskItem, ThreadTerminalRecord } from '../persistence/entities';
import type { LiveVerificationJudge, LiveVerificationVerdict } from './live-verification-judge';
import { TOOL_SHAPES } from '../sandbox/image/host-tool-schemas';

/**
 * W4 — the SECTION/PHASE DRIVER unit tests. Every dependency is mocked (NO real LLM / git / network):
 * the driver walks a 2-thread job to ONE PR, each thread running as ONE orchestrator batch; step
 * step-state persists; `resume()` fast-forwards completed work after a simulated restart; threads
 * share one branch ⇒ one PR; a mid-build `request_operator_input` call pauses + resumes a thread.
 *
 * The store is an in-memory fake the test can re-instantiate a fresh driver against — that's how the
 * resumability test simulates a process restart (same rows, new driver). Zero real I/O.
 */

// ── an in-memory DriverStore the tests can introspect + survive a "restart" ──────────────────────

interface OperatorInputCard {
  questionId: string;
  question: string;
  answer: string | null;
  delivered: boolean;
}

interface ReviewChildRow {
  id: string;
  parentId: string;
  kind: string;
  brief: string;
  ordinal: number;
  config: Record<string, unknown>;
  status: ThreadStatus;
  condition: ThreadCondition;
  reviewFindings: unknown[] | null;
}

interface StoreState {
  job: Job;
  record: DecisionRecord | null;
  threads: DriverThread[];
  steps: Step[];
  route: JobRoute;
  operatorInputCards: OperatorInputCard[];
  systemNotices?: string[];
  /** A builder's materialized review children (review_lens + post_review rows). Lazily created. */
  reviewChildren?: ReviewChildRow[];
}

function makeStore(state: StoreState): {
  store: DriverStoreService;
  state: StoreState;
} {
  let nextQuestionId = 1;
  const store = {
    loadJob: vi.fn(async () => ({ ...state.job })),
    runningJobs: vi.fn(async () =>
      state.job.status === 'running' && state.job.halt == null
        ? [{ ...state.job }]
        : [],
    ),
    setJobStatus: vi.fn(async (_id: string, status: Job['status']) => {
      state.job.status = status;
    }),
    setActivity: vi.fn(async (_id: string, activity: Job['activity']) => {
      state.job.activity = activity;
    }),
    setJobHalt: vi.fn(async (_id: string, halt: Job['halt']) => {
      state.job.halt = halt;
      state.job.activity = 'idle';
    }),
    clearJobHalt: vi.fn(async (_id: string) => {
      state.job.halt = null;
    }),
    hasRecentSystemOperatorNotice: vi.fn(async (_id: string, text: string) => {
      return (state.systemNotices ?? []).includes(text);
    }),
    setSessionResume: vi.fn(async () => undefined),
    setFeatureBranch: vi.fn(async (_id: string, branch: string) => {
      state.job.featureBranch = branch;
    }),
    setPrReady: vi.fn(async (_id: string, prUrl: string) => {
      state.job.prUrl = prUrl;
      state.job.status = 'done';
      state.job.activity = 'idle';
    }),
    // ── ship-review gate fakes ───────────────────────────────────────────────────────────────────────
    parkForShipReview: vi.fn(async (_id: string) => {
      if (state.job.status !== 'running') return false;
      state.job.status = 'awaiting_ship_review';
      state.job.activity = 'idle';
      return true;
    }),
    approveShip: vi.fn(async (_id: string) => {
      if (state.job.status !== 'awaiting_ship_review') return false;
      state.job.shipReviewApprovedAt = new Date();
      state.job.status = 'running';
      return true;
    }),
    clearShipApproval: vi.fn(async (_id: string) => {
      state.job.shipReviewApprovedAt = null;
    }),
    decisionRecord: vi.fn(async () => state.record),
    threadsForJob: vi.fn(async () => state.threads.map((s) => ({ ...s }))),
    getThread: vi.fn(async (id: string) => {
      const s = state.threads.find((x) => x.id === id);
      return s ? { ...s } : null;
    }),
    setThreadStatus: vi.fn(async (id: string, status: ThreadStatus) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.status = status;
      // Child rows (review_lens / post_review) share this setter.
      const c = (state.reviewChildren ?? []).find((x) => x.id === id);
      if (c) c.status = status;
    }),
    setThreadCondition: vi.fn(async (id: string, condition: ThreadCondition) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.condition = condition;
      // Child rows (review_lens / post_review) share this setter.
      const c = (state.reviewChildren ?? []).find((x) => x.id === id);
      if (c) c.condition = condition;
    }),
    // Set-once persist of the thread's start HEAD; returns the authoritative (first-written) sha.
    ensureThreadStartSha: vi.fn(async (id: string, candidate: string) => {
      const s = state.threads.find((x) => x.id === id);
      if (s && !s.startSha) s.startSha = candidate;
      return s?.startSha ?? candidate;
    }),
    setThreadPlan: vi.fn(
      async (id: string, plan: string, handoffIn: string | null) => {
        const s = state.threads.find((x) => x.id === id);
        if (s) {
          s.plan = plan;
          s.handoffIn = handoffIn;
        }
      },
    ),
    setThreadOrientation: vi.fn(async (id: string, orientation: string) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.orientation = orientation;
    }),
    setThreadHandoffOut: vi.fn(async (id: string, handoffOut: string) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.handoffOut = handoffOut;
    }),
    // Review CHILD threads (post-build review as real rows). Materialize is idempotent; each lens/post_review
    // is its own row with its own status + findings.
    materializeReviewChildren: vi.fn(
      async (
        parent: { id: string },
        childSpecs: Array<{ kind: string; brief: string; config: Record<string, unknown> }>,
      ) => {
        const kids = (state.reviewChildren ??= []);
        const existing = kids.filter((c) => c.parentId === parent.id);
        if (existing.length) return existing.map((c) => ({ ...c }));
        const created = childSpecs.map((c, i) => ({
          id: `${parent.id}-child-${i}`,
          parentId: parent.id,
          kind: c.kind,
          brief: c.brief,
          ordinal: (i + 1) * 10,
          config: c.config,
          status: 'pending' as ThreadStatus,
          condition: 'none' as ThreadCondition,
          reviewFindings: null as unknown[] | null,
        }));
        kids.push(...created);
        return created.map((c) => ({ ...c }));
      },
    ),
    reviewChildren: vi.fn(async (parentId: string) =>
      (state.reviewChildren ?? [])
        .filter((c) => c.parentId === parentId)
        .map((c) => ({ ...c })),
    ),
    setThreadReviewFindings: vi.fn(async (id: string, findings: unknown[]) => {
      const c = (state.reviewChildren ?? []).find((x) => x.id === id);
      if (c) c.reviewFindings = findings;
    }),
    // PR Review lifecycle writes — no-ops for the driver flow tests (display state only).
    startPrReview: vi.fn(async () => undefined),
    setPrReviewStatus: vi.fn(async () => undefined),
    stepsForThread: vi.fn(async (threadId: string) =>
      state.steps.filter((p) => p.threadId === threadId).map((p) => ({ ...p })),
    ),
    lockSteps: vi.fn(async (thread: DriverThread, planned: PlannedStep[]) => {
      const existing = state.steps.filter((p) => p.threadId === thread.id);
      if (existing.length) return existing.map((p) => ({ ...p }));
      const rows: Step[] = planned.map((p, i) => ({
        id: `${thread.id}-ph${i}`,
        threadId: thread.id,
        jobId: thread.jobId,
        ordinal: (i + 1) * 10,
        title: p.title,
        brief: p.brief,
        stage: 'build',
        status: 'pending' as StepStatus,
        sessionId: null,
        batchOrdinal: null,
        legOrdinal: 1,
        commitSha: null,
      }));
      state.steps.push(...rows);
      return rows.map((p) => ({ ...p }));
    }),
    setStepState: vi.fn(
      async (id: string, stage: string, status: StepStatus) => {
        const p = state.steps.find((x) => x.id === id);
        if (p) {
          p.stage = stage;
          p.status = status;
        }
      },
    ),
    setBatchOrdinals: vi.fn(async (assignments: Array<[string, number]>) => {
      for (const [id, batchOrdinal] of assignments) {
        const p = state.steps.find((x) => x.id === id);
        if (p) p.batchOrdinal = batchOrdinal;
      }
    }),
    setStepCommit: vi.fn(async (id: string, commitSha: string) => {
      const p = state.steps.find((x) => x.id === id);
      if (p) p.commitSha = commitSha;
    }),
    route: vi.fn(async () => state.route),
    // ── operator-input cards (request_operator_input) — a small in-memory backing on state ─────────
    findOpenOperatorInputCard: vi.fn(async (_jobId: string) => {
      const open = state.operatorInputCards.find((c) => c.answer == null);
      return open ? { questionId: open.questionId, question: open.question } : null;
    }),
    openOperatorInputCard: vi.fn(async (_jobId: string, question: string) => {
      const questionId = `q${nextQuestionId++}`;
      state.operatorInputCards.push({
        questionId,
        question,
        answer: null,
        delivered: false,
      });
      return { questionId };
    }),
    readOperatorInputAnswer: vi.fn(async (_jobId: string, questionId: string) => {
      const card = state.operatorInputCards.find((c) => c.questionId === questionId);
      return card?.answer ?? null;
    }),
    markOperatorInputDelivered: vi.fn(async (_jobId: string, questionId: string) => {
      const card = state.operatorInputCards.find((c) => c.questionId === questionId);
      if (card) card.delivered = true;
    }),
    // ── typed terminal record (ADR 0004) — backed on the thread object so a "restart" (fresh driver, same
    //    state) preserves the assertion, exactly like the DB column. ────────────────────────────────────
    recordThreadTermination: vi.fn(
      async (threadId: string, terminal: ThreadTerminalRecord) => {
        const s = state.threads.find((x) => x.id === threadId);
        if (s) (s as { terminal_record?: ThreadTerminalRecord | null }).terminal_record = terminal;
      },
    ),
    clearTerminalRecord: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      if (s) (s as { terminal_record?: ThreadTerminalRecord | null }).terminal_record = null;
    }),
    getTerminalRecord: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      return (s as { terminal_record?: ThreadTerminalRecord | null })?.terminal_record ?? null;
    }),
    // Transcript anchor (halt-wake) — no steps/legs session seeded in these tests, so the anchor resolves
    // undefined; present so `writeCompletionMd` doesn't call an undefined fn.
    resolveSessionAnchor: vi.fn(async (_threadId: string) => undefined),
    // ── Leg rotation (context-rot mitigation) — no prior rotation in these tests, so the driver folds no seed
    //    and rotates ONLY on a self-authored handoff. `completeLegRotation` is present for the type only. ──
    getPendingLegSeed: vi.fn(async (_anchorStepId: string) => null),
    completeLegRotation: vi.fn(async () => null),
    recordBuildSystemChunk: vi.fn(async () => undefined),
    getThreadTasks: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as { tasks?: TaskItem[] } | undefined;
      return Array.isArray(s?.tasks) ? s!.tasks! : [];
    }),
    dropOpenThreadTasks: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as { tasks?: TaskItem[] } | undefined;
      if (!Array.isArray(s?.tasks)) return 0;
      let dropped = 0;
      s!.tasks = s!.tasks!.map((t) => {
        if (t.status === 'pending' || t.status === 'in_progress') {
          dropped++;
          return { ...t, status: 'dropped' as const };
        }
        return t;
      });
      return dropped;
    }),
    recordActiveLeg: vi.fn(async () => undefined),
    getLegsForJob: vi.fn(async (_jobId: string) => []),
    threadJobId: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      return s?.jobId ?? null;
    }),
    // ── Phase 3 halt-wake + bounded fix (ADR 0004 rider 4) — backed on the thread objects, like the DB ──
    setHaltOwed: vi.fn(async (threadId: string, outcome: string) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      if (s) {
        s.halt_outcome = outcome;
        s.halt_waked_at = null;
      }
    }),
    clearHalt: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      if (s) {
        s.halt_outcome = null;
        s.halt_waked_at = null;
      }
    }),
    markHaltWaked: vi.fn(async (threadId: string, gen: number) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      // Generation-keyed CAS: only stamp if the budget is unchanged + still owed + un-waked.
      if (
        s &&
        (s.halt_fix_attempts ?? 0) === gen &&
        s.halt_waked_at == null &&
        s.halt_outcome != null
      ) {
        s.halt_waked_at = new Date();
      }
    }),
    threadsAwaitingHaltWake: vi.fn(async (jobId?: string) =>
      state.threads
        .filter((x) => {
          const h = x as HaltFields;
          return (
            h.halt_outcome != null &&
            h.halt_waked_at == null &&
            (jobId == null || x.jobId === jobId)
          );
        })
        .map((x) => {
          const h = x as HaltFields;
          return {
            jobId: x.jobId,
            threadId: x.id,
            gen: h.halt_fix_attempts ?? 0,
            outcome: h.halt_outcome as 'blocked' | 'incomplete' | 'failed',
          };
        }),
    ),
    claimHaltFixAttempt: vi.fn(async (threadId: string, cap: number) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      const used = s?.halt_fix_attempts ?? 0;
      if (!s || used >= cap) return { ok: false, used: cap };
      s.halt_fix_attempts = used + 1;
      return { ok: true, used: used + 1 };
    }),
    haltFixAttempts: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      return s?.halt_fix_attempts ?? 0;
    }),
    haltOutcome: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as HaltFields | undefined;
      return (s?.halt_outcome as 'blocked' | 'incomplete' | 'failed' | null) ?? null;
    }),
    rearmHaltedThreads: vi.fn(async (jobId: string) => {
      let n = 0;
      for (const x of state.threads) {
        const h = x as HaltFields;
        if (x.jobId === jobId && (h.halt_fix_attempts ?? 0) > 0) {
          h.halt_fix_attempts = 0;
          n += 1;
        }
      }
      return n;
    }),
    // Decision d1 — completion wake (mirrors the halt trio's presence-for-type-only stubbing above).
    setDoneWakeOwed: vi.fn(async (_threadId: string, _reason: 'final' | 'notable') => undefined),
    threadsAwaitingDoneWake: vi.fn(async (_jobId?: string) => []),
    markDoneWaked: vi.fn(async (_threadId: string) => undefined),
    masterReviewThreadId: vi.fn(async (jobId: string) => {
      const s = state.threads.find((x) => x.jobId === jobId && x.kind === 'master_review');
      return s?.id ?? null;
    }),
  } as unknown as DriverStoreService;
  return { store, state };
}

/** The Phase-3 halt columns, backed on the in-memory thread objects (mirrors the DB columns). */
type HaltFields = {
  halt_outcome?: string | null;
  halt_waked_at?: Date | null;
  halt_fix_attempts?: number;
};

// ── the rest of the mocked collaborators ─────────────────────────────────────────────────────────

const REPO: ProjectRepo = {
  repoId: 'proj',
  gitUrl: 'https://github.com/acme/widget',
  defaultBranch: 'main',
  repoPath: '/repos/proj',
};
const RESOLVED: ResolvedRepo = {
  projectRepo: REPO,
  owner: 'acme',
  repo: 'widget',
  defaultBranch: 'main',
  token: 'ghtok',
};

function makeRepoResolver(): DriverRepoResolver {
  return { resolve: vi.fn(async () => RESOLVED) };
}

function makeGit(): {
  git: LocalGitService;
  pushed: string[];
  commits: string[];
  advanceHead: () => void;
} {
  const commits: string[] = [];
  const pushed: string[] = [];
  let sha = 0;
  const git = {
    createFeatureSandbox: vi.fn(
      async (_repo: ProjectRepo, branch: string): Promise<FeatureSandbox> => ({
        repoId: 'proj',
        branch,
        worktreePath: `/wt/${branch}`,
        gitUrl: REPO.gitUrl,
        token: 'ghtok',
      }),
    ),
    headSha: vi.fn(async () => `sha${sha}`),
    // The ship step reads the live branch (detached HEAD → null → fall back to the canonical sandbox.branch).
    // Null keeps the fake shipping on `atlas/feature-job-abcd` (= sandbox.branch), which the tests assert.
    currentBranch: vi.fn(async () => null),
    // Writers commit their own work now; the host READS HEAD instead of committing. The fake build turn
    // (below) advances `sha` to simulate the writer's commit, so `headSha` returns the fresh sha the driver
    // stamps. `hasChanges` reports a CLEAN tree by default (the writer committed) — no dirty-tree nudge.
    hasChanges: vi.fn(async () => false),
    push: vi.fn(async (sandbox: FeatureSandbox) => {
      pushed.push(sandbox.branch);
    }),
    // Empty by default (ADR 0005's pre-filter treats an empty changed-file list as non-runtime, so the
    // live-verification judge is never called for the pre-existing tests below unless a test overrides
    // this to simulate a real runtime-touching diff).
    changedFileNames: vi.fn(async () => [] as string[]),
    // Pre-ship leak-scan gate (BuildShipService) — clean by default so ship proceeds to open the PR.
    scanBranchForForbidden: vi.fn(async () => [] as string[]),
  } as unknown as LocalGitService;
  // Simulates the writer's in-sandbox commit advancing HEAD: the host reads the fresh sha (never creates it).
  // The default build turn calls this after `complete_thread`, so each thread's `sectionStartSha` advances.
  const advanceHead = () => {
    sha += 1;
  };
  return { git, pushed, commits, advanceHead };
}

function makePr(): { pr: GithubPrService; opened: Array<{ head: string }> } {
  const opened: Array<{ head: string }> = [];
  const pr = {
    openPullRequest: vi.fn(async (_token: string, args: { head: string }) => {
      opened.push({ head: args.head });
      return {
        url: 'https://github.com/acme/widget/pull/1',
        number: 1,
        existing: false,
      };
    }),
    // Atlas opens the PR in-sandbox (that open turn is mocked here, so it doesn't call `report_pr_opened`);
    // the host CONFIRMS it via head-branch discovery. Return a synthetic PR so `ship` latches
    // pr_url/pr_number and flips the job `done` — mirroring the real "Atlas opened it, host discovered it"
    // flow. (`ship` no longer blind-flips `done` on a discovery miss — that was the flaky-loop bug.)
    findOpenPullByHead: vi.fn(async (_token: string, args: { head: string }) => ({
      url: `https://github.com/acme/widget/pull/1`,
      number: 1,
      head: args.head,
    })),
  } as unknown as GithubPrService;
  return { pr, opened };
}

/**
 * The mock engine turn. By default it simulates the orchestrator asserting completion — it calls the host
 * bridge's `complete_thread` before returning, so the driver reads a `done` record (ADR 0004). Options let a
 * test simulate the two new failure shapes: `completeThread: false` → the turn ends WITHOUT asserting (→
 * `incomplete`); `transientFailures: N` → the turn throws a transient infra error its first N invocations
 * (→ the driver's silent retry) before succeeding.
 */
function makeTurn(
  opts: {
    completeThread?: boolean;
    transientFailures?: number;
    /** Simulate the orchestrator VOLUNTARILY halting via `block_thread` (ADR 0004 Phase 3) instead of
     *  asserting completion — the turn calls `block_thread` with this and returns cleanly. */
    blockThread?: { reason: string; detail: string };
  } = {},
  /** The writer commits + pushes its own work now; call this after `complete_thread` to advance the fake
   *  git HEAD (what the host then READS). Wired to `makeGit().advanceHead` for the default turn. */
  advanceHead?: () => void,
): {
  turn: TurnRunnerService;
  calls: Array<{ mode: string; stepId?: string | null }>;
} {
  const completeThread = opts.completeThread ?? true;
  let remainingFailures = opts.transientFailures ?? 0;
  const calls: Array<{ mode: string; stepId?: string | null }> = [];
  const turn = {
    runTurn: vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        toolBridge?: ToolBridgeOptions;
      }) => {
        calls.push({ mode: input.mode, stepId: input.stepId });
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          // A transient infra blip (NOT auth/detached/timeout/unresumable) — the driver retries it silently.
          throw new Error('sandbox exec failed: connection reset by peer');
        }
        // Simulate the orchestrator voluntarily blocking (Phase 3) — a terminal assertion, no complete_thread.
        if (opts.blockThread && input.toolBridge?.tools?.['block_thread']) {
          await input.toolBridge.tools['block_thread'](opts.blockThread);
          return {
            report: `blocked step ${input.stepId}`,
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        }
        // Simulate the orchestrator's terminal assertion (what a real build turn MUST do).
        if (completeThread && input.toolBridge?.tools?.['complete_thread']) {
          await input.toolBridge.tools['complete_thread']({
            summary: `built step ${input.stepId}`,
            verification: [
              { kind: 'test', command: 'pnpm test', exitCode: 0, outputTail: 'ok' },
            ],
          });
          // The writer committed + pushed before asserting completion — its in-sandbox commit advances HEAD,
          // which the host then reads to stamp `commit_sha`. Advancing here isolates each thread's diff base.
          advanceHead?.();
        }
        // Simulate a clean diagnostics done-gate iteration (ADR 0004 rider 3): a gate turn's tool bridge
        // exposes ONLY `report_verification` (no `complete_thread`) — a well-behaved orchestrator reports
        // clean by default so the gate passes on its first iteration, matching the happy-path assumption
        // every other test in this file makes.
        if (input.toolBridge?.tools?.['report_verification']) {
          await input.toolBridge.tools['report_verification']({ passed: true });
        }
        return {
          report: `did step ${input.stepId}`,
          session: {
            id: 'sess',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: input.mode as 'plan' | 'execute' | 'review',
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      },
    ),
    // Pipe-transport shape: no restart re-attach → the driver always kicks a fresh (session-resuming) turn.
    canReattach: () => false,
  } as unknown as TurnRunnerService;
  return { turn, calls };
}

/** Simulate the orchestrator's ADR-0004 terminal assertion (`complete_thread`) from an INLINE turn mock, so
 *  the driver reads a `done` record and advances. Inline mocks that omit this ⇒ the thread is `incomplete`. */
async function assertThreadDone(input: {
  stepId?: string | null;
  toolBridge?: ToolBridgeOptions;
}): Promise<void> {
  await input.toolBridge?.tools?.['complete_thread']?.({
    summary: `built step ${input.stepId}`,
  });
}

/** Counters live on the returned object; the service is a thin wrapper bumping them. */
interface VisibilityHandle {
  visibility: PlanVisibilityService;
  postSectionPlan: ReturnType<typeof vi.fn>;
}
function makeVisibility(): VisibilityHandle {
  const postSectionPlan = vi.fn(async () => 'vis-ts');
  return {
    visibility: { postSectionPlan } as unknown as PlanVisibilityService,
    postSectionPlan,
  };
}

interface AutofixHandle {
  autofix: AutoFixStage;
  autofixThread: ReturnType<typeof vi.fn>;
  autofixPullRequest: ReturnType<typeof vi.fn>;
  runReviewLens: ReturnType<typeof vi.fn>;
  applyReviewFindings: ReturnType<typeof vi.fn>;
  ensureContextDiff: ReturnType<typeof vi.fn>;
  emitReviewNotice: ReturnType<typeof vi.fn>;
}
function makeAutofix(): AutofixHandle {
  const autofixThread = vi.fn(async () => cleanSummary('thread'));
  const autofixPullRequest = vi.fn(async () => cleanSummary('pull_request'));
  // The child-thread review runners. `ensureContextDiff` returns a NON-empty change set so the driver's
  // per-lens turns actually run (an empty diff would short-circuit the review). Each lens returns no
  // findings (a clean review) — enough to exercise the flow without a fix turn.
  const runReviewLens = vi.fn(async () => []);
  const applyReviewFindings = vi.fn(async () => ({ fixReport: '', commits: [] }));
  const ensureContextDiff = vi.fn(
    async (ctx: Record<string, unknown>) => ({ ...ctx, diff: 'x', changedFiles: ['f.ts'] }),
  );
  // Posts a self-describing NOTICE on a review child's own lane (failed lens/fix, or "nothing to fix").
  const emitReviewNotice = vi.fn(async () => undefined);
  return {
    autofix: {
      autofixThread,
      autofixPullRequest,
      runReviewLens,
      applyReviewFindings,
      ensureContextDiff,
      emitReviewNotice,
    } as unknown as AutoFixStage,
    autofixThread,
    autofixPullRequest,
    runReviewLens,
    applyReviewFindings,
    ensureContextDiff,
    emitReviewNotice,
  };
}

function cleanSummary(mode: 'thread' | 'pull_request') {
  return {
    mode,
    lensesRun: [],
    findings: [],
    fixesAttempted: false,
    fixReport: '',
    commits: [],
    clean: true,
  };
}

/** A fake live-verification judge whose verdict the test controls (and whose calls it can assert). Mirrors
 *  `decision-classifier.service.spec.ts`'s `fakeLlm()` pattern — NO default parameter (a test that wants
 *  "judge unavailable" must be able to pass `undefined` explicitly and have it stick; a default parameter
 *  would silently substitute a real verdict, since JS defaults also fire on an explicit `undefined` arg). */
function fakeJudge(
  verdict: LiveVerificationVerdict | undefined,
): LiveVerificationJudge & { calls: number } {
  return {
    calls: 0,
    async judge() {
      this.calls++;
      return verdict;
    },
  };
}

/** `assemble()`'s own default judge when a test doesn't care about the gate — `runtimeSurfaceTouched: false`
 *  so the ~1100 lines of pre-existing `complete_thread`-driven tests keep asserting `status: 'done'`
 *  unchanged even though every one of them now routes through the gate. */
function defaultTestJudge(): LiveVerificationJudge & { calls: number } {
  return fakeJudge({
    runtimeSurfaceTouched: false,
    liveVerificationAdequate: true,
    reason: 'default test verdict',
  });
}

function makeSurface(): { surface: ChatSurface; posts: string[] } {
  const posts: string[] = [];
  const surface = {
    name: 'agent',
    post: vi.fn(async (_ch: string, text: string) => {
      posts.push(text);
      return 'ts';
    }),
  } as unknown as ChatSurface;
  return { surface, posts };
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-abcdef12',
    orgId: 'T1',
    repoId: 'proj',
    origin: 'chat',
    surfaceThreadRef: null,
    title: 'Add widgets',
    baseBranch: null,
    kind: 'feature',
    status: 'running',
    activity: 'build',
    halt: null,
    decisionRecordId: 'dr-1',
    featureBranch: null,
    currentBranch: null,
    prUrl: null,
    prNumber: null,
    shipReviewApprovedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRecord(): DecisionRecord {
  return {
    id: 'dr-1',
    orgId: 'T1',
    repoId: 'proj',
    jobId: 'job-abcdef12',
    status: 'approved',
    overview: 'Build the widget feature.',
    decisions: [],
    threadTitles: ['Backend', 'Frontend'],
    approvedBy: 'U1',
    approvedAt: new Date(),
  };
}

function makeSections(): DriverThread[] {
  return [thread('sec-be', 10, 'Backend'), thread('sec-fe', 20, 'Frontend')];
}

function thread(
  id: string,
  ordinal: number,
  brief: string,
  status: ThreadStatus = 'pending',
  isMasterReview = false,
  condition: ThreadCondition = 'none',
): DriverThread {
  return {
    id,
    jobId: 'job-abcdef12',
    orgId: 'T1',
    ordinal,
    brief,
    plan: null,
    orientation: null,
    handoffIn: null,
    handoffOut: null,
    status,
    condition,
    kind: isMasterReview ? 'master_review' : 'builder',
    parentThreadId: null,
    startSha: null,
  };
}

/** Assemble a driver over a given store-state + collaborators; returns everything the tests assert on. */
function assemble(
  state: StoreState,
  opts: {
    env?: Record<string, string>;
    turn?: TurnRunnerService;
    turnRegistry?: Pick<import('../sandbox/turn-registry.service').TurnRegistry, 'listRunning'>;
    judge?: LiveVerificationJudge & { calls: number };
    /** Override `CredentialResolver.anthropicKey` — defaults to the env-fallback shape (no key). A test that
     *  exercises the judge-unavailable-WITH-key path (transient infra hold) sets this to return a key. */
    anthropicKey?: (orgId?: string) => Promise<string | undefined>;
    /** SHIP-REVIEW GATE: feature/bugfix builds now PARK before the PR (awaiting the operator's "Ship it").
     *  Default true → the harness auto-clicks "Ship it" the instant the gate parks, so the many
     *  build→ship pipeline tests still reach `done` without each re-encoding the gate. The dedicated
     *  ship-gate tests pass `false` to assert the park + drive the approval by hand. */
    autoShipApprove?: boolean;
    /** Point the host-owned context bucket (`contextDirHost`) at a REAL dir so a test can assert the
     *  on-disk halt-trail write (`<ctx>/generated/threads/<name>/completion.md`). Defaults to `/ctx`. */
    contextDirHost?: string;
    /** Point the thread sandbox's worktree at a REAL dir so a test can assert NOTHING is written under
     *  `<worktree>/.atlas/threads/` (the halt-trail relocation regression guard). */
    worktreePath?: string;
  } = {},
) {
  const { store } = makeStore(state);
  const repos = makeRepoResolver();
  const { git, pushed, commits, advanceHead } = makeGit();
  const { pr, opened } = makePr();
  const made = makeTurn({}, advanceHead);
  const turn = opts.turn ?? made.turn;
  const calls = made.calls;
  const visibility = makeVisibility();
  const autofix = makeAutofix();
  const { surface, posts } = makeSurface();
  // A no-op env by default: every guard reads its code default. opts.env supplies overrides per test.
  const env = {
    get: vi.fn((k: string) => opts.env?.[k]),
  } as unknown as EnvService;
  // The shared transcript spine over a fake live store + a capturing durable sink — so build turns persist
  // their transcript (and the `build_anchor`) through the same path production uses, and tests can assert it.
  const liveTurns = { push: vi.fn(), end: vi.fn(), snapshot: vi.fn(() => null) } as unknown as LiveTurnStore;
  const sunk: Array<{
    jobId: string;
    block: {
      kind: string;
      text?: string;
      meta?: Record<string, unknown> | null;
    };
  }> = [];
  const blockSink = {
    appendBlock: vi.fn(
      async (
        jobId: string,
        block: {
          kind: string;
          text?: string;
          meta?: Record<string, unknown> | null;
        },
      ) => {
        sunk.push({ jobId, block });
        if ((block.meta as { source?: unknown } | null)?.source === 'system_operator' && block.text) {
          const notices = state.systemNotices ?? [];
          notices.push(block.text);
          state.systemNotices = notices;
        }
      },
    ),
    appendBlockOnce: vi.fn(
      async (
        jobId: string,
        promptKey: string,
        block: { kind: string; text?: string; meta?: Record<string, unknown> | null },
      ) => {
        if (sunk.some((s) => s.block.kind === 'agent_prompt' && (s.block.meta as { promptKey?: string } | null)?.promptKey === promptKey)) {
          return;
        }
        sunk.push({ jobId, block: { ...block, meta: { ...(block.meta ?? {}), promptKey } } });
      },
    ),
  } as unknown as BlockSink;
  // Captures task-event folds — the master-review bridge's `task_create`/`task_update` (parity with the
  // Claude lanes' SDK task tools) — so the task-bridge tests can assert the checklist writes; also backs the
  // TurnHarnessFactory below (harness-driven folds aren't asserted here — see turn-harness.service.spec.ts).
  const taskEvents: Array<{
    scope: { kind: string; id: string };
    toolName: string;
    input: Record<string, unknown>;
    result: unknown;
  }> = [];
  const taskSink = {
    applyTaskEvent: vi.fn(
      async (
        scope: { kind: string; id: string },
        toolName: string,
        input: Record<string, unknown>,
        result: unknown,
      ) => {
        taskEvents.push({ scope, toolName, input, result });
      },
    ),
  } as unknown as TaskEventSink;
  const usage = { applyHarvest: vi.fn().mockResolvedValue(undefined) } as unknown as OauthUsageService;
  const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, taskSink, usage);
  // BuildShipService's direct ENGINE_RUNNER dependency (the PR Review orchestrator) — separate from the
  // `turn`/`calls` fake above (TurnRunnerService, used by per-thread build turns) so PR Review's one
  // execute turn doesn't inflate the per-thread `execTurns` count.
  const engineCalls: Array<{ mode: string; engine: string }> = [];
  const engineRunner = {
    run: vi.fn(async (args: { mode: string; engine: string }) => {
      engineCalls.push({ mode: args.mode, engine: args.engine });
      return { result: 'PR Review: no findings.', usage: undefined };
    }),
  } as unknown as EngineRunnerPort;
  // LeaderElectionService stub: `draining`/`leader` are flippable so tests can simulate SIGTERM (drain) and a
  // mid-drive leadership loss (demotion). Mirrors production: `isLeader()` is false while draining.
  const electionState = { draining: false, leader: true };
  const judge = opts.judge ?? defaultTestJudge();
  // Captures the driver's Phase-3 brain wakes (`notifyThreadHalted`) fired via the lazy ModuleRef brain.
  const wakes: Array<{
    jobId: string;
    threadId: string;
    outcome: 'blocked' | 'incomplete' | 'failed';
  }> = [];
  // Records each seeded open-PR turn (`BuildShipService` → `brain.openPrAtShip`). Replaces the old proxy of
  // "an engine execute/claude call happened" now that the ship step is a brain turn, not a separate session.
  const shipSeeds: Array<{ jobId: string; branch: string }> = [];
  // ModuleRef: the lazy brain lookup shared by the driver (halt wakes) AND BuildShipService
  // (the seeded open-PR turn). A stub brain records `notifyThreadHalted` wakes + `openPrAtShip` seeds (the
  // seeded turns themselves are exercised in the brain specs — here the host latches by branch discovery).
  const brainModuleRef = {
    get: () => ({
      openPrAtShip: async (input: { jobId: string; branch: string }) => {
        shipSeeds.push({ jobId: input.jobId, branch: input.branch });
      },
      notifyThreadHalted: async (
        jobId: string,
        threadId: string,
        outcome: 'blocked' | 'incomplete' | 'failed',
        gen: number,
      ) => {
        wakes.push({ jobId, threadId, outcome });
        // Simulate the REAL brain: it stamps `halt_waked_at` (gen-keyed) on the wake turn's SUCCESS tail.
        await store.markHaltWaked(threadId, gen);
      },
    }),
  } as unknown as ModuleRef;
  const driver = new ThreadDriver(
    store,
    repos,
    git,
    pr,
    turn,
    visibility.visibility,
    autofix.autofix,
    surface,
    env,
    // SANDBOX_PROVIDER: host-local no-op attach (the host never runs commands in the sandbox).
    {
      attach: async ({ sandbox }: { sandbox: FeatureSandbox }) => sandbox,
      teardown: async () => undefined,
      teardownByIdentity: async () => undefined,
      contextDirHost: () => '/ctx',
      playgroundDirHost: () => '/playground',
      brainTranscriptProjectsDir: () => null,
      supervisorDirHost: () => null,
      probeLiveness: async () => ({ status: 'unknown' as const }),
    },
    // CredentialResolver: env-fallback shape (no tenant rows) — api_key auth, no token.
    {
      anthropicKey: opts.anthropicKey ?? (async () => undefined),
      openaiKey: async () => undefined,
      githubToken: async () => undefined,
      engineAuth: async () => ({ secret: 'test-secret' }),
    } as unknown as CredentialResolver,
    // OauthUsageService: the session-limit park reads getResetAt; default → no harvested window.
    { getResetAt: () => undefined, applyHarvest: vi.fn().mockResolvedValue(undefined) } as unknown as OauthUsageService,
    // McpResolver: no user-defined MCP servers in tests.
    { resolveForTurn: async () => [], resolveForSandbox: async () => [] } as never,
    // McpOAuthService: no OAuth servers in tests (and the fake SANDBOX_PROVIDER has no kickMcpHubRefresh anyway).
    { refreshForSandbox: async () => ({ rotated: false }) } as never,
    // SkillResolver: no skills in tests.
    { resolveForTurn: async () => [] } as never,
    // JobLifecycleService: returns the thread's pre-provisioned sandbox — the ONLY sandbox path now
    // (the brain provisions every thread before any build runs). Its branch is the source of truth.
    {
      ensureContainer: async () => ({
        sandbox: {
          repoId: 'proj',
          branch: 'atlas/feature-job-abcd',
          worktreePath: opts.worktreePath ?? '/wt/atlas/feature-job-abcd',
          gitUrl: REPO.gitUrl,
          token: 'ghtok',
        },
        wasReset: false,
      }),
      findSandbox: async () => null,
      recordPr: async () => undefined,
      // The host-owned context bucket root — where the driver renders `/context/generated` projections
      // (deviations.md, and the relocated halt-trail completion.md). Defaults to `/ctx`; a test can repoint
      // it at a real temp dir to assert the on-disk write.
      contextDirHost: (_jobId: string, _orgId: string) => opts.contextDirHost ?? '/ctx',
    } as unknown as import('./job-lifecycle.service').JobLifecycleService,
    // BuildShipService: the real terminal "ship" over the same git/pr/store fakes, so the leak-scan/latch
    // assertions hold. The open-PR step is now a SEEDED BRAIN TURN resolved via `brainModuleRef` (no separate
    // engine session), and the host latches the PR by branch discovery.
    new BuildShipService(git, pr, store, brainModuleRef),
    // PipelineAwarenessStore: append is a best-effort no-op (passive milestones not asserted here).
    {
      appendMarker: async () => undefined,
      drainAndAdvance: async () => ({ markers: [], stateChanged: false }),
    } as unknown as import('./pipeline-awareness.store').PipelineAwarenessStore,
    // LeaderElectionService: reads the flippable `electionState.draining` so the shutdown-guard test can
    // assert that a drain-induced abort leaves the job `running` instead of `failed`.
    {
      isDraining: () => electionState.draining,
      // Production `isLeader()` is false while draining (state='draining') — mirror that so a drain also
      // trips the drive's leadership fence, not just the terminal-error `isDraining()` check.
      isLeader: () => electionState.leader && !electionState.draining,
    } as unknown as LeaderElectionService,
    turnHarness,
    blockSink,
    // TurnRegistry: no in-flight rows by default (fresh runs) — reattach lookup returns empty. A reattach
    // test overrides `listRunning` to surface a matching in-flight `step` row.
    (opts.turnRegistry ?? {
      listRunning: async () => [],
    }) as unknown as import('../sandbox/turn-registry.service').TurnRegistry,
    // ModuleRef: the lazy brain lookup (halt wakes), shared with BuildShipService above.
    brainModuleRef,
    judge,
    taskSink,
  );
  // SHIP-REVIEW GATE auto-approve: unless a test opts out, simulate the operator clicking "Ship it" the
  // instant the gate parks — so the build→ship pipeline tests keep reaching `done`. The re-drive fast-
  // forwards the already-`done` threads (no re-execute/re-materialize) and ships.
  if (opts.autoShipApprove !== false) {
    (store.parkForShipReview as ReturnType<typeof vi.fn>).mockImplementation(async (jobId: string) => {
      if (state.job.status !== 'running') return false;
      state.job.status = 'awaiting_ship_review';
      // Fire the "Ship it" on a MACROtask (not a microtask): the parking drive must fully unwind and clear
      // its `active` guard first, else the re-drive is dropped as a duplicate and the job wedges at running.
      setTimeout(() => {
        void driver.resolveShipApprovalDurably(jobId, 'auto-test');
      }, 0);
      return true;
    });
  }
  return {
    driver,
    store,
    state,
    git,
    taskEvents,
    pr,
    turn,
    visibility,
    autofix,
    surface,
    pushed,
    commits,
    opened,
    calls,
    engineCalls,
    shipSeeds,
    posts,
    liveTurns,
    blockSink,
    sunk,
    electionState,
    judge,
    wakes,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('ThreadDriver — the legible thread/step pipeline', () => {
  it('walks a 2-thread job to ONE PR (lock one step per thread → orchestrate execute → autofix → handoff → next → PR-tail)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // No more build-time plan turns — each thread locks ONE step and runs as ONE orchestrator execute
    // turn: 2 threads ⇒ 2 execute turns, zero plan turns.
    const planTurns = h.calls.filter((c) => c.mode === 'plan');
    const execTurns = h.calls.filter((c) => c.mode === 'execute');
    expect(planTurns).toHaveLength(0);
    expect(execTurns).toHaveLength(2); // 2 threads × 1 orchestrator session

    // Per-thread post-build review ran once per thread (children materialized + lenses run); Atlas opens the
    // PR via a seeded brain turn — ONE ship seed (master review no longer runs in ship; it's now a Codex build
    // thread, absent from this mock's thread list).
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(2);
    expect(h.autofix.runReviewLens).toHaveBeenCalled();
    expect(h.shipSeeds).toEqual([{ jobId: state.job.id, branch: 'atlas/feature-job-abcd' }]);

    // Both threads are done with a handoff; the SECOND thread received the first's handoff.
    expect(state.threads.every((s) => s.status === 'done')).toBe(true);
    expect(state.threads[1].handoffIn).toContain('Backend');

    // ONE branch — threads stacked on the same feature branch (the host never pushes; Atlas pushes
    // in-sandbox as part of the ship turn, which ran).
    expect(state.job.featureBranch).toBe('atlas/feature-job-abcd');
    expect(
      h.shipSeeds.length,
    ).toBeGreaterThanOrEqual(1);
    expect(state.job.status).toBe('done');
  });

  it('a failed review lens posts a self-describing notice on its lane and marks the child failed (never a silent blank)', async () => {
    // Repro of the "blank review-agent pane" incident: the lens turn dies before streaming, so `abort()`
    // persisted only the prompt snapshot. The driver must now post the REASON on the lens's own lane so the
    // pane explains itself, isolate the failure (job still completes), and reset the lens to `failed`.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    h.autofix.runReviewLens.mockRejectedValue(
      new Error('Command failed: git status\nfatal: cannot chdir to packages/jwt-auth'),
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // A notice went onto a LENS lane ({ lensId }) carrying the folded-in error reason (shortReason).
    const lensNotices = h.autofix.emitReviewNotice.mock.calls.filter(
      (c) => (c[1] as { lensId?: string }).lensId && String(c[2]).includes('failed to run'),
    );
    expect(lensNotices.length).toBeGreaterThan(0);
    expect(String(lensNotices[0][2])).toContain('fatal: cannot chdir to packages/jwt-auth');

    // Every review_lens child carries the `failed` CONDITION (step stays where it was), and the failure
    // never sank the job.
    const lensKids = (state.reviewChildren ?? []).filter((c) => c.kind === 'review_lens');
    expect(lensKids.length).toBeGreaterThan(0);
    expect(lensKids.every((c) => c.condition === 'failed')).toBe(true);
    expect(state.job.status).toBe('done');
  });

  it('post-review with no actionable findings posts a "nothing to fix" notice and marks the child done', async () => {
    // The clean-review path (every lens returns []) runs no fix turn — it must still leave an explicit line
    // on the fix lane so the Post-review fixes pane reads as "nothing to fix" rather than a silent blank.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    const fixNotices = h.autofix.emitReviewNotice.mock.calls.filter(
      (c) => (c[1] as { fix?: boolean }).fix === true && String(c[2]).includes('nothing to fix'),
    );
    expect(fixNotices.length).toBeGreaterThan(0);
    const postKids = (state.reviewChildren ?? []).filter((c) => c.kind === 'post_review');
    expect(postKids.length).toBeGreaterThan(0);
    expect(postKids.every((c) => c.status === 'done')).toBe(true);
    // No fix turn ran (nothing actionable) — the notice replaced it, not augmented it.
    expect(h.autofix.applyReviewFindings).not.toHaveBeenCalled();
  });

  it('fast-forwards a thread a concurrent/stale drive already finished — no re-execute, no re-materialize of review children', async () => {
    // Models the torn-review-agents incident: the run-start snapshot showed the 2nd thread not-done, but a
    // parallel/restart-spawned drive marked it `done` (and reviewed it) before this drive reached it. The live
    // re-read must catch that and fast-forward — NOT re-run the orchestrator (which would re-execute the
    // committed step) or re-materialize/re-run its review children.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    // The 2nd thread reads back `done` live (with a persisted handoff) even though the snapshot said pending.
    const staleId = state.threads[1].id;
    (h.store.getThread as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        const s = state.threads.find((x) => x.id === id);
        if (!s) return null;
        return id === staleId
          ? { ...s, status: 'done', handoffOut: 'HO-from-other-drive' }
          : { ...s };
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Only the FIRST thread executed + reviewed; the already-done 2nd thread was fast-forwarded.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(1);
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(1);
    // It never materialized review children for the finished thread (no re-review).
    const materialized = (
      h.store.materializeReviewChildren as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(materialized.some((c) => c[0].id === staleId)).toBe(false);
    // The build still completes to a PR.
    expect(state.job.status).toBe('done');
  });

  it('runs the master-review thread as a CODEX execute turn (xhigh) and SKIPS per-thread auto-fix for it', async () => {
    // Capture per-turn engine + reasoning effort so we can assert the master-review branch flipped them.
    const runs: Array<{ mode: string; engine: string; effort?: string; stepId?: string | null }> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          engine: string;
          modelReasoningEffort?: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          runs.push({
            mode: input.mode,
            engine: input.engine,
            effort: input.modelReasoningEffort,
            stepId: input.stepId,
          });
          await assertThreadDone(input);
          return {
            report: `did step ${input.stepId}`,
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: input.engine as 'claude' | 'codex',
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;

    // One feature thread + the appended master-review thread (as persistPlan would leave it).
    const review = thread('sec-review', 30, 'Master review — whole-diff review & fix', 'pending', true);
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend'), review],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The feature thread runs Claude; the master-review thread runs Codex at xhigh.
    const execs = runs.filter((r) => r.mode === 'execute');
    expect(execs).toHaveLength(2);
    expect(execs[0].engine).toBe('claude');
    expect(execs[1].engine).toBe('codex');
    expect(execs[1].effort).toBe('xhigh');

    // The post-build review ran for the feature thread ONLY — the master-review thread IS the review (its
    // spec declares no children), so it materializes none.
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(1);
    expect(state.threads.every((s) => s.status === 'done')).toBe(true);
  });

  it('build turns ride the shared transcript spine: richStream on, blocks tagged meta.phaseId, a build_anchor per thread batch', async () => {
    const seen: Array<{ mode: string; richStream?: boolean }> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          jobId: string;
          stepId?: string | null;
          richStream?: boolean;
          toolBridge?: ToolBridgeOptions;
          onEvent?: (e: { kind: string; [k: string]: unknown }) => void;
        }) => {
          seen.push({ mode: input.mode, richStream: input.richStream });
          input.onEvent?.({ kind: 'thinking', text: 'planning the edit' });
          input.onEvent?.({ kind: 'text', text: 'editing the file' });
          input.onEvent?.({
            kind: 'tool_use',
            id: 't1',
            name: 'Edit',
            input: { file_path: 'a.ts' },
          });
          input.onEvent?.({ kind: 'tool_result', id: 't1', result: 'ok' });
          await assertThreadDone(input);
          return {
            report: `did ${input.stepId}`,
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;

    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { turn });
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Every EXECUTE (build) turn requested richStream.
    const exec = seen.filter((c) => c.mode === 'execute');
    expect(exec.length).toBeGreaterThan(0);
    expect(exec.every((c) => c.richStream === true)).toBe(true);

    // A synthetic `build_anchor` row per thread's batch, each tagged with its phaseId.
    const anchors = h.sunk.filter((s) => s.block.kind === 'build_anchor');
    expect(anchors.length).toBeGreaterThan(0);
    expect(
      anchors.every((a) => typeof a.block.meta?.phaseId === 'string'),
    ).toBe(true);

    // The transcript blocks landed via the durable sink — all tagged with meta.phaseId (peeled into the
    // step). Excludes the ship turn's own blocks (tagged `shipId` — Atlas opening the PR in-sandbox) and
    // the Master Review orchestrator's own blocks (tagged `prReviewId`, not `phaseId`) — both separate
    // sessions entirely, see build-ship.service.ts.
    const transcript = h.sunk.filter(
      (s) =>
        ['chat', 'thinking', 'tool'].includes(s.block.kind) &&
        s.block.meta?.prReviewId == null &&
        s.block.meta?.shipId == null &&
        // Operator-facing system notices (e.g. the ship-review "Shipping…" notice) are not build
        // transcript — they carry no phaseId, like the halt cards.
        s.block.meta?.source !== 'system_operator',
    );
    expect(transcript.length).toBeGreaterThan(0);
    expect(
      transcript.every((t) => typeof t.block.meta?.phaseId === 'string'),
    ).toBe(true);
    expect(transcript.some((t) => t.block.kind === 'thinking')).toBe(true);
    expect(
      transcript.some(
        (t) =>
          t.block.kind === 'tool' &&
          (t.block.meta as { name?: string }).name === 'Edit',
      ),
    ).toBe(true);

    // The STABLE thread lane was used (push called with a `thread:` lane arg) — like the brain's `main`.
    const pushCalls = (h.liveTurns.push as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      pushCalls.some(
        (c) =>
          typeof c[3] === 'string' && (c[3] as string).startsWith('thread:'),
      ),
    ).toBe(true);

    // The old `build_event` relay is gone — no build_event posts to the surface.
    expect(h.posts.every((p) => !p.includes('[tool]'))).toBe(true);
  });

  it('re-attaches a still-live build turn on resume instead of re-running it (recovery parity with the brain)', async () => {
    // A single pre-locked thread whose ONE batch already STARTED before a restart: its step carries a
    // persisted session + batch ordinal but no commit, so the driver re-enters runBatch for that batch.
    const steps: Step[] = [
      {
        id: 'sec-be-ph0',
        threadId: 'sec-be',
        jobId: 'job-abcdef12',
        ordinal: 10,
        title: 'Backend',
        brief: 'Backend',
        stage: 'build' as const,
        status: 'building' as StepStatus,
        sessionId: 'sess-live', // persisted at turn start → the batch is a RESUME, not a fresh start
        batchOrdinal: 1,
        legOrdinal: 1,
        commitSha: null,
      },
    ];
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps,
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };

    // A runner that CAN re-attach; `reattach` resolves the in-flight turn and `runTurn` is a spy that must
    // NOT fire for the execute batch (no re-run). Typed with its real `TurnRunnerService.reattach` param so
    // `reattach.mock.calls[0][0]` below type-checks against what the driver actually passed it.
    const reattach = vi.fn(async (_input: Parameters<TurnRunnerService['reattach']>[0]) => {
      // The re-supplied bridge serves the in-flight `complete_thread` the pre-restart turn was mid-way through.
      await _input.toolBridge?.tools?.['complete_thread']?.({ summary: 'resumed and finished' });
      return {
      report: 'resumed build',
      session: {
        id: 'sess-live',
        jobId: 'job-abcdef12',
        stepId: 'sec-be-ph0',
        engine: 'claude' as const,
        mode: 'execute' as const,
        branch: 'b',
        worktreePath: '/wt/b',
      },
      };
    });
    const runTurn = vi.fn();
    const turn = { runTurn, reattach, canReattach: () => true } as unknown as TurnRunnerService;
    // A matching in-flight registry row for the thread's batch (lane `thread:<threadId>`, ctx.anchorStepId).
    const listRunning = vi.fn(async () => [
      {
        turn_id: 'turn-live',
        job_id: 'job-abcdef12',
        org_id: 'T1',
        channel: 'C1',
        lane: 'thread:sec-be',
        kind: 'step',
        container_id: 'ctr-1',
        status: 'running',
        ctx: { anchorStepId: 'sec-be-ph0' },
      },
    ]);

    const h = assemble(state, { turn, turnRegistry: { listRunning } as never });
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Re-attached the live turn (with the ORIGINAL turn id + container) — never re-ran the execute batch.
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach.mock.calls[0][0]).toMatchObject({
      turnId: 'turn-live',
      containerId: 'ctr-1',
      stepId: 'sec-be-ph0',
    });
    expect(runTurn).not.toHaveBeenCalled();
    // A resume never re-emits the batch's START markers (no duplicate build_anchor).
    expect(h.sunk.filter((s) => s.block.kind === 'build_anchor')).toHaveLength(0);
    // The resumed turn's transcript persisted + the batch committed → the run finishes; the ship turn ran
    // (Atlas opens the PR in-sandbox, the host never does).
    expect(
      h.shipSeeds.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('every step ran in the SAME feature branch (threads share one thread sandbox)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // All threads build on the thread's single durable sandbox, so the job adopts that one branch and
    // never cuts a per-feature worktree of its own.
    expect(state.job.featureBranch).toBe('atlas/feature-job-abcd');
    expect(h.git.createFeatureSandbox).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.mode === 'execute').length).toBeGreaterThan(
      1,
    );
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
  });

  it('persists resumable step step-state (the locked step ends done/done; session set during the turn)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    const steps = state.steps.filter((p) => p.threadId === 'sec-be');
    expect(steps).toHaveLength(1); // one locked step per thread now (the orchestrate anchor)
    expect(steps.every((p) => p.status === 'done' && p.stage === 'done')).toBe(
      true,
    );
    // setStepState was driven to 'building' then 'done' for the one step (explicit, resumable cursor).
    expect(
      (h.store.setStepState as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[2],
      ),
    ).toEqual(['building', 'done']);
  });

  it('resume() fast-forwards completed threads/steps after a simulated restart (no re-execution)', async () => {
    // Simulate a restart MID-JOB: thread 1 (Backend) already done with a handoff + its step done;
    // thread 2 (Frontend) still pending, no steps yet. Same store rows, a FRESH driver.
    const doneBackend = thread('sec-be', 10, 'Backend', 'done');
    doneBackend.handoffOut = 'handoff from Backend';
    const state: StoreState = {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      threads: [doneBackend, thread('sec-fe', 20, 'Frontend')],
      steps: [
        {
          id: 'sec-be-ph0',
          threadId: 'sec-be',
          jobId: 'job-abcdef12',
          ordinal: 10,
          title: 'Backend',
          brief: 'Backend',
          stage: 'done',
          status: 'done',
          sessionId: 's',
          batchOrdinal: 1,
          legOrdinal: 1,
          commitSha: null,
        },
      ],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The done Backend thread was NOT re-executed (no exec turn for it). Only the Frontend thread ran
    // (1 execute turn, no plan turn — there is no more build-time planning).
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(0);
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(1);
    // The ship turn ran (Atlas opens the PR in-sandbox, the host never does).
    expect(
      h.shipSeeds.length,
    ).toBeGreaterThanOrEqual(1);
    expect(state.job.status).toBe('done');
  });

  it('orchestrate resume: a batch whose anchor already has a commit_sha FAST-FORWARDS (no re-run) (issue #6)', async () => {
    // Crash AFTER the batch committed (commit_sha stamped on the anchor) but BEFORE the step row flipped
    // to done. Resume must NOT re-run the orchestrator against the already-committed tree.
    const state: StoreState = {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing')],
      steps: [
        {
          id: 'sec-be-ph0',
          threadId: 'sec-be',
          jobId: 'job-abcdef12',
          ordinal: 10,
          title: 'Backend',
          brief: 'Backend',
          stage: 'build',
          status: 'building',
          sessionId: 's',
          batchOrdinal: 1,
          legOrdinal: 1,
          commitSha: 'abc123',
        },
      ],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The committed batch fast-forwarded: NO execute turn, NO new commit, the step marked done.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(h.commits.filter((m) => m.startsWith('Backend —'))).toHaveLength(0);
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
    expect(state.job.status).toBe('done');
  });

  it('posts in-thread progress as the build advances (issue #2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.posts.some((p) => p.includes('Starting the build'))).toBe(true);
    expect(
      h.posts.some(
        (p) => p.includes('Planning thread') && p.includes('Backend'),
      ),
    ).toBe(true);
    expect(h.posts.some((p) => p.toLowerCase().includes('building'))).toBe(
      true,
    );
    // The ship step no longer posts an "opening the PR" system message — it seeds a visible brain turn.
    expect(h.shipSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('relays a clear "build failed — why" when a step errors, never dead-ends silently (issue #2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    // The execute turn explodes → must propagate to a failure relay.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error('engine exploded mid-step');
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'failed');

    expect(state.job.halt?.kind).toBe('failed');
    expect(
      h.posts.some(
        (p) =>
          p.includes('Build failed') && p.includes('engine exploded mid-step'),
      ),
    ).toBe(true);
    expect(h.opened).toHaveLength(0); // no PR opened on a failed build
  });

  it('marks the thread INCOMPLETE and HALTS (no PR) when the orchestrator never calls complete_thread (ADR 0004)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // The build turn runs CLEAN but never asserts completion — a clean exit is NOT evidence of done.
    const { turn } = makeTurn({ completeThread: false });
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'incomplete');

    // The STEP stays at `executing`; the halt is carried on the orthogonal condition overlay.
    expect(state.threads[0].status).toBe('executing'); // halted, NOT silently done
    expect(state.threads[0].condition).toBe('incomplete');
    expect(state.job.halt?.kind).toBe('incomplete'); // needs-you, recoverable — NOT done, NOT failed
    expect(h.opened).toHaveLength(0); // nothing shipped
    expect(
      h.posts.some((p) => p.includes('without asserting completion')),
    ).toBe(true); // a durable halt card, never a silent dead-end
    expect(h.store.materializeReviewChildren).not.toHaveBeenCalled(); // review skipped on a halt
  });

  it('writes the halt trail to /context/generated (host-owned), NOT the git worktree (ADR 0004 relocation)', async () => {
    const ctxDir = mkdtempSync(join(tmpdir(), 'atlas-ctx-'));
    const worktreeDir = mkdtempSync(join(tmpdir(), 'atlas-wt-'));
    try {
      const state: StoreState = {
        job: makeJob(),
        record: makeRecord(),
        threads: [thread('sec-be', 10, 'Backend')],
        steps: [],
        route: { channel: 'C1', threadTs: 't1' },
        operatorInputCards: [],
      };
      // A clean-but-incomplete turn halts the build (ADR 0004), driving the completion.md write.
      const { turn } = makeTurn({ completeThread: false });
      const h = assemble(state, { turn, contextDirHost: ctxDir, worktreePath: worktreeDir });

      await h.driver.dispatch(state.job);
      // The trail is rendered under `<contextDirHost>/generated/threads/<ordinal>-<slug>/` — here `010-backend`.
      const trail = join(ctxDir, 'generated', 'threads', '010-backend', 'completion.md');
      // Wait for CONTENT, not just the file's existence: writeCompletionMd is fire-and-forget and
      // writeFile creates the (empty) file before the content lands, so an existence-only wait can read
      // '' and flake (observed in CI). Waiting for non-empty content makes the assertions deterministic.
      await flushUntil(
        () => existsSync(trail) && readFileSync(trail, 'utf8').length > 0,
      );

      expect(existsSync(trail)).toBe(true);
      expect(readFileSync(trail, 'utf8')).toContain('# Thread halted: Backend');

      // Regression guard (the whole point): nothing is written into the git worktree.
      expect(existsSync(join(worktreeDir, '.atlas'))).toBe(false);
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it('SILENTLY RETRIES a transient infra blip and completes — never surfaces a phantom "failed" (ADR 0004)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // First execute throws a transient (allowlisted) sandbox error; the retry succeeds and asserts done.
    const { turn, calls } = makeTurn({ transientFailures: 1 });
    const h = assemble(state, {
      turn,
      env: { DRIVER_TRANSIENT_RETRY_MS: '1' },
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(state.job.status).toBe('done'); // recovered
    expect(calls.filter((c) => c.mode === 'execute').length).toBeGreaterThanOrEqual(2); // retried
    expect(
      (h.store.setJobStatus as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[1] === 'failed',
      ),
    ).toBe(false); // never stamped failed
    expect(h.posts.some((p) => p.includes('Build failed'))).toBe(false); // no phantom error relay
  });

  it('shutdown drain: a step error WHILE DRAINING leaves the job running (resumable on boot), never failed', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    // Start as leader so the drive's leadership fence lets the turn RUN; SIGTERM then arrives mid-turn (the
    // mock flips `draining` before throwing), so the in-flight turn's host-side await is cut off → it throws
    // like a generic abort. Without the guard this would flip the job `failed` and boot-resume would never
    // re-drive it (`runningJobs()` only re-drives `status:'running'`).
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        h.electionState.draining = true; // SIGTERM lands while the turn is in flight
        throw new Error('aborted: backend draining');
      },
    );

    await h.driver.dispatch(state.job);
    // Wait until the execute turn has been attempted (so the drive catch has run), then drain a few ticks.
    await flushUntil(() =>
      (h.turn.runTurn as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    await flushUntil(() => false, 20);

    expect(state.job.status).toBe('running'); // LEFT running — boot-resume continues it
    expect(
      (h.store.setJobStatus as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[1] === 'failed',
      ),
    ).toBe(false); // never stamped failed
    expect(h.posts.some((p) => p.includes('Build failed'))).toBe(false); // no failure relay on shutdown
  });

  it('leadership fence: a drive demoted mid-build YIELDS at the next thread boundary — no further thread, no ship, job left running', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(), // 2 threads
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    // Lose leadership the moment thread 1 finishes (a connection blip demoted us; a standby now owns the job).
    // The fence at the top of the next loop iteration must yield BEFORE running thread 2.
    (h.store.setThreadStatus as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string, status: ThreadStatus) => {
        const s = state.threads.find((x) => x.id === id);
        if (s) s.status = status;
        if (id === state.threads[0].id && status === 'done') {
          h.electionState.leader = false;
        }
      },
    );

    await h.driver.dispatch(state.job);
    // Thread 1 completes, then the drive should yield. Wait for thread 1 done, then settle.
    await flushUntil(() => state.threads[0].status === 'done');
    await flushUntil(() => false, 30);

    // Thread 2 never ran; nothing shipped; the job is LEFT running (no status write) for a leader to re-drive.
    expect(state.threads[1].status).not.toBe('done');
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(1);
    expect(h.opened).toHaveLength(0);
    expect(state.job.status).toBe('running');
    expect(
      (h.store.setJobHalt as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0); // a cooperative yield is NOT a failure — no halt recorded
  });

  it('aborts + relays a step that exceeds PHASE_TIMEOUT_MS (issue #3 circuit breaker)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { env: { PHASE_TIMEOUT_MS: '20' } });
    // The execute turn NEVER settles AND ignores the abort signal (mimics the real SDK stuck in a
    // non-yielding subprocess). The HARD race-timeout must still bound the driver.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Promise(() => {}), // never settles, never honors abort
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'failed');

    expect(state.job.halt?.kind).toBe('failed');
    expect(
      h.posts.some(
        (p) => p.includes('Build failed') && p.includes('PHASE_TIMEOUT_MS'),
      ),
    ).toBe(true);
  });

  it('relays off-spec DEVIATION lines a step flags in its report (issue #7)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: {
        mode: string;
        stepId?: string | null;
        toolBridge?: ToolBridgeOptions;
      }) => {
        await assertThreadDone(input);
        return {
          report:
            'Implemented the endpoint.\nDEVIATION: added a README nobody asked for.',
          session: {
            id: 's',
            jobId: 'j',
            stepId: input.stepId ?? null,
            engine: 'claude',
            mode: 'execute',
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(
      h.posts.some(
        (p) => p.includes('Off-spec') && p.includes('README nobody asked for'),
      ),
    ).toBe(true);
    expect(state.job.status).toBe('done'); // a deviation is surfaced, not a failure
  });

  it('PAUSES the job (not failed) on an EngineAuthError and relays a pause notice (resume feature)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new EngineAuthError('401 invalid api key', 'sess-401');
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'blocked_credentials');

    expect(state.job.halt?.kind).toBe('blocked_credentials'); // halted, NOT failed
    expect(
      h.posts.some((p) => /paused/i.test(p) && /credential|auth/i.test(p)),
    ).toBe(true);
    expect(h.opened).toHaveLength(0);
  });

  it('parks a build lane on a Claude session limit with one durable resume notice', async () => {
    const resetAt = '2026-07-09T22:00:00.000Z';
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1', orgId: 'T1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new EngineSessionLimitError(
        `Claude session limit (five_hour); resets ${resetAt}`,
        resetAt,
        'five_hour',
        'sess-limit',
      );
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'session_limit');

    expect(state.job.halt).toMatchObject({
      kind: 'session_limit',
      resumeAt: resetAt,
    });
    expect(h.store.setSessionResume).toHaveBeenCalledWith(
      state.job.id,
      resetAt,
      expect.objectContaining({ lane: 'build', resetSource: 'usage_api' }),
    );
    expect(h.sunk.filter((s) => s.block.meta?.sessionLimit === true)).toHaveLength(1);
    expect(h.posts.filter((p) => p.includes("You've hit your session limit"))).toHaveLength(1);

    await h.driver.retry(state.job.id);
    await flushUntil(() => (h.store.setJobHalt as ReturnType<typeof vi.fn>).mock.calls.length >= 2);

    expect(h.sunk.filter((s) => s.block.meta?.sessionLimit === true)).toHaveLength(1);
    expect(h.posts.filter((p) => p.includes("You've hit your session limit"))).toHaveLength(1);
  });

  it('resumePaused re-drives a paused job to completion; no-ops if the job is not paused', async () => {
    // no-op path: a non-paused job is left alone.
    const running: StoreState = {
      job: makeJob({ status: 'done' }),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'done')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const noop = assemble(running);
    await noop.driver.resumePaused(running.job.id);
    expect(noop.opened).toHaveLength(0); // never re-driven

    // resume path: a credential-halted job (phase preserved) is cleared + driven to a PR.
    const state: StoreState = {
      job: makeJob({
        status: 'running',
        halt: { kind: 'blocked_credentials', reason: '401', at: new Date().toISOString() },
      }),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    await flushUntil(() => state.job.status === 'done');
    expect(state.job.status).toBe('done');
    expect(
      h.shipSeeds.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('request_operator_input pauses the thread and resumes on the operator\'s answer', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // The build turn calls the tool bridge's `request_operator_input`, then returns using its answer.
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          jobId: string;
          stepId?: string | null;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const result = await input.toolBridge!.tools['request_operator_input']!({
            question: 'Use Postgres or SQLite?',
          });
          // The orchestrator resumes with the answer, finishes the work, and asserts completion.
          await assertThreadDone(input);
          return {
            report: `answered: ${JSON.stringify(result)}`,
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: 'execute' as const,
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;

    const h = assemble(state, { turn });

    // Pre-seed the answer the moment a card is opened, so the poll loop returns on its very first read.
    const originalOpen = (h.store.openOperatorInputCard as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (h.store.openOperatorInputCard as ReturnType<typeof vi.fn>).mockImplementation(
      async (jobId: string, question: string) => {
        const opened = await originalOpen(jobId, question);
        const card = state.operatorInputCards.find((c) => c.questionId === opened.questionId);
        if (card) card.answer = 'Use Postgres.';
        return opened;
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The tool was consulted (a card was opened) and resolved to the answer.
    expect(h.store.openOperatorInputCard).toHaveBeenCalledTimes(1);
    expect(h.store.findOpenOperatorInputCard).toHaveBeenCalled();
    expect(h.store.readOperatorInputAnswer).toHaveBeenCalled();
    expect(h.store.markOperatorInputDelivered).toHaveBeenCalledTimes(1);

    // The pause is now on the condition overlay: it went to 'paused' then back to 'none' around the pause,
    // while the STEP stays at 'executing' throughout.
    const conditionCalls = (h.store.setThreadCondition as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(conditionCalls).toContain('paused');
    const pausedIdx = conditionCalls.indexOf('paused');
    expect(conditionCalls.slice(pausedIdx + 1)).toContain('none');

    // The build proceeded to completion carrying the answer in its report.
    expect(state.job.status).toBe('done');
  });
});

// ── ADR 0005 — the live-verification judge gate inside `complete_thread` ───────────────────────────

/** A judge fake that also captures each call's input, for the two Codex-requested regression cases below
 *  (proving the diff signal the judge sees, not just whether it was called). */
function capturingJudge(
  verdict: LiveVerificationVerdict | undefined,
): LiveVerificationJudge & {
  calls: number;
  seenChangedFiles: string[][];
  seenSummaries: string[];
} {
  return {
    calls: 0,
    seenChangedFiles: [],
    seenSummaries: [],
    async judge(input) {
      this.calls++;
      this.seenChangedFiles.push(input.changedFiles);
      this.seenSummaries.push(input.terminalRecordSummary);
      return verdict;
    },
  };
}

/** Cast a git mock's `changedFileNames` to a mock fn so a test can stub its return per baseSha. Mirrors
 *  the `as ReturnType<typeof vi.fn>` cast style already used on the store mocks above. */
function stubChangedFileNames(
  git: LocalGitService,
  impl: (worktreePath: string, baseSha: string) => Promise<string[]>,
): void {
  (git as unknown as { changedFileNames: ReturnType<typeof vi.fn> }).changedFileNames =
    vi.fn(impl);
}

describe('ThreadDriver — re-halt idempotency (stops the all-night "Thread blocked → Holding." spam)', () => {
  // A blocked thread leaves the JOB `running`, so the 30-min reap's resume() re-drives it and re-enters the
  // "already blocked → re-halt" short-circuit. It must NOT re-post the card or re-arm the owed wake once the
  // halt was already delivered — except for a `judge_unavailable` transient hold, whose periodic re-wake IS
  // its recovery. And it MUST still notify if haltJob never ran (halt_outcome missing → wake would be lost).
  function blockedState(o: {
    reason?: 'unverified' | 'judge_unavailable' | 'question';
    haltOutcome?: 'blocked' | null;
    haltWakedAt?: Date | null;
    haltFixAttempts?: number;
  }): StoreState {
    const t = thread('sec-be', 10, 'Backend', 'executing', false, 'paused');
    (t as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record = {
      status: 'blocked',
      summary: 'blocked',
      blocked: { reason: o.reason ?? 'unverified', detail: 'needs your input' },
    };
    const h = t as HaltFields;
    h.halt_outcome = o.haltOutcome ?? null;
    h.halt_waked_at = o.haltWakedAt ?? null;
    h.halt_fix_attempts = o.haltFixAttempts ?? 0;
    return {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      threads: [t],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }
  const blockedCards = (h: { sunk: Array<{ block: { text?: string } }> }) =>
    h.sunk.filter((s) => s.block.text?.includes('Thread blocked'));

  it('already-notified block (owed-wake row exists + delivered) → re-drive re-posts NOTHING and does not re-arm', async () => {
    // haltJob already ran on the first block: halt_outcome set, wake delivered (halt_waked_at stamped).
    const state = blockedState({ reason: 'unverified', haltOutcome: 'blocked', haltWakedAt: new Date() });
    const h = assemble(state);
    (h.store.setHaltOwed as ReturnType<typeof vi.fn>).mockClear();

    await h.driver.resume();
    await flush();

    expect(blockedCards(h)).toHaveLength(0); // no re-posted "Thread blocked" card
    expect(h.store.setHaltOwed).not.toHaveBeenCalled(); // no re-arm
    expect(await h.store.threadsAwaitingHaltWake('job-abcdef12')).toHaveLength(0); // stays acked
  });

  it('REGRESSION: blocked record but halt_outcome MISSING (crash before haltJob) → re-drive still runs haltJob ONCE', async () => {
    // The block_thread terminal record persisted, but haltJob never created the owed-wake row. A re-drive must
    // NOT suppress — else `threadsAwaitingHaltWake` has nothing to deliver and the brain is never woken.
    const state = blockedState({ reason: 'unverified', haltOutcome: null, haltWakedAt: null });
    const h = assemble(state);

    await h.driver.resume();
    await flush();

    expect(h.store.setHaltOwed).toHaveBeenCalledWith('sec-be', 'blocked'); // owed-wake row created
    expect(blockedCards(h).length).toBeGreaterThan(0); // the card posts (the FIRST notification)
    expect(await h.store.threadsAwaitingHaltWake('job-abcdef12')).toHaveLength(1);
  });

  it('judge_unavailable transient hold KEEPS re-arming on re-drive (its only recovery path)', async () => {
    // Already delivered, but judge_unavailable must re-wake the brain to retry_thread when the judge recovers.
    const state = blockedState({ reason: 'judge_unavailable', haltOutcome: 'blocked', haltWakedAt: new Date() });
    const h = assemble(state);
    (h.store.setHaltOwed as ReturnType<typeof vi.fn>).mockClear();

    await h.driver.resume();
    await flush();

    expect(h.store.setHaltOwed).toHaveBeenCalledWith('sec-be', 'blocked'); // re-armed
    expect(await h.store.threadsAwaitingHaltWake('job-abcdef12')).toHaveLength(1); // owed again
  });
});

describe('ThreadDriver — ADR 0005 live-verification judge gate (always on — no rollout dial)', () => {
  it('touched + adequate verification → done (judge consulted, never gates)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'curl evidence present',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(1);
    expect(state.threads[0].status).toBe('done');
    expect(state.job.status).toBe('done');
    expect(state.job.prUrl).toBeTruthy(); // shipped
  });

  it('a STRING `verification` (not an array) is coerced into one entry, never silently dropped', async () => {
    // Live-validated gap (07-03): the orchestrator sometimes collapses its verification narrative into
    // one free-text string instead of discrete {kind,command,exitCode,outputTail} entries. Losing that
    // silently would make a genuinely-verified thread look unverified to the judge for the wrong reason.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const evidence = 'booted the real app and curled it: GET /health/version -> 200 {"version":"1.0.0"}';
    const turn = {
      runTurn: vi.fn(async (input: { stepId?: string | null; jobId: string; toolBridge?: ToolBridgeOptions }) => {
        await input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'built it',
          verification: evidence, // a STRING, not an array — the shape that was silently dropped before
        });
        // The diagnostics done-gate's follow-up turn exposes ONLY `report_verification` — report clean so
        // the gate passes (mirrors `makeTurn`'s shared happy-path assumption).
        await input.toolBridge?.tools?.['report_verification']?.({ passed: true });
        return {
          report: 'did it',
          session: {
            id: 'sess',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: 'execute' as const,
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      }),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'evidence present',
    });
    const h = assemble(state, { turn, judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    const term = (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record;
    expect(term.verification).toHaveLength(1);
    expect(term.verification?.[0].outputTail).toBe(evidence);
    expect(term.status).toBe('done');
  });

  it('a decisive evidence token PAST char 2000 survives ingestion → the judge input (no head-only truncation)', async () => {
    // Regression for job 76f0ee2a: the `effort=high` proof landed past the head-only slice, so the judge
    // was fed truncated evidence and (correctly, given what it saw) blocked. Ingestion now head+TAIL clamps,
    // and the whole-item render preserves the tail — the decisive token must reach the judge.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // >3000 chars total, decisive token at ~char 3000 — past BOTH the old 2000 ingestion slice and the old
    // 300 renderer slice, and in the tail region the clamp keeps.
    const decisive = 'DECISIVE_effort=high_in_pipeline_response';
    const longTail = `${'DIAG '.repeat(600)}${decisive} TAIL`;
    const turn = {
      runTurn: vi.fn(async (input: { stepId?: string | null; jobId: string; toolBridge?: ToolBridgeOptions }) => {
        await input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'plumbed effort through to the SDK',
          verification: [{ kind: 'reported', command: 'curl /pipeline', exitCode: 0, outputTail: longTail }],
        });
        await input.toolBridge?.tools?.['report_verification']?.({ passed: true });
        return {
          report: 'did it',
          session: {
            id: 'sess',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: 'execute' as const,
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      }),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const judge = capturingJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'effort=high observed live',
    });
    const h = assemble(state, { turn, judge });
    stubChangedFileNames(h.git, async () => ['src/engine/run-claude.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBeGreaterThanOrEqual(1);
    // The exact evidence the judge blocked on before now reaches it.
    expect(judge.seenSummaries[0]).toContain(decisive);
  });

  it('touched + INADEQUATE verification → downgraded to blocked (unverified), build halts, no PR', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: false,
      reason: 'only unit tests ran',
      missingChecks: 'curl the new endpoint',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.threads[0].condition === 'paused');

    expect(judge.calls).toBe(1);
    expect(state.job.status).toBe('running'); // NOT failed, NOT paused — Phase 3 owns the resume path
    expect(h.opened).toHaveLength(0); // nothing shipped on an unverified claim
    const term = (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record;
    expect(term.status).toBe('blocked');
    expect(term.blocked?.reason).toBe('unverified');
    expect(term.blocked?.detail).toContain('only unit tests ran');
    expect(term.blocked?.detail).toContain('curl the new endpoint'); // missingChecks flows into detail
    expect(h.posts.some((p) => p.includes('curl the new endpoint'))).toBe(true);
  });

  it('NOT touched → done regardless of what verification[] contains', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // The judge says the diff never touched a runtime surface at all — done regardless of `liveVerificationAdequate`.
    const judge = fakeJudge({
      runtimeSurfaceTouched: false,
      liveVerificationAdequate: false,
      reason: 'refactor only, no runtime surface',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/internal/helper.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(1);
    expect(state.threads[0].status).toBe('done');
    expect(state.job.prUrl).toBeTruthy(); // shipped
  });

  it('judge UNAVAILABLE (undefined) → conservative blocked, never a silent done', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge(undefined); // no key / no verdict
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.threads[0].condition === 'paused');

    expect(judge.calls).toBe(1);
    const term = (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record;
    expect(term.status).toBe('blocked');
    expect(term.blocked?.reason).toBe('unverified');
    // No Anthropic key resolves in the default CredentialResolver fake → the operator-facing message names it.
    expect(term.blocked?.detail).toContain('no Anthropic API key configured');
  });

  it('judge UNAVAILABLE but a key IS configured → transient HOLD (judge_unavailable), job stays running, never rested', async () => {
    // 07-09 incident: an Anthropic outage made the judge return undefined for EVERY thread. With a key present
    // that is a TRANSIENT infra failure, not unverified work — the thread must hold + retry, NOT burn the fix
    // budget and rest the job `budget_exhausted`. Re-drive it up to the cap and prove the job never rests.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge(undefined); // judge unreachable (Anthropic down)
    const h = assemble(state, { judge, anthropicKey: async () => 'sk-ant-present' });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.threads[0].condition === 'paused');

    const term = (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record;
    expect(term.status).toBe('blocked');
    expect(term.blocked?.reason).toBe('judge_unavailable'); // distinct from 'unverified'
    expect(term.blocked?.detail).toContain('temporarily unavailable');
    // Held for retry — the job is NOT rested and the operator card does NOT claim the fix budget is spent.
    expect(state.job.status).toBe('running');
    expect(h.posts.some((p) => p.includes('temporarily unavailable'))).toBe(true);
    expect(h.posts.some((p) => p.includes('autonomous fix attempts'))).toBe(false);
    expect(h.opened).toHaveLength(0); // nothing shipped
  });

  it('judge THROWING → caught, conservative blocked, never crashes the drive', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const throwing: LiveVerificationJudge & { calls: number } = {
      calls: 0,
      async judge() {
        this.calls++;
        throw new Error('boom');
      },
    };
    const h = assemble(state, { judge: throwing });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.threads[0].condition === 'paused');

    expect(throwing.calls).toBe(1);
    const term = (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record;
    expect(term.status).toBe('blocked');
    expect(term.blocked?.reason).toBe('unverified');
  });

  it('master-review thread BYPASSES the judge entirely (judge.calls stays 0)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-review', 30, 'Master review — whole-diff review & fix', 'pending', true)],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: false,
      reason: 'would gate if it were ever consulted',
    });
    const h = assemble(state, { judge });
    // Even with a runtime-looking changed-file set, the master-review bypass short-circuits BEFORE the
    // gate ever calls `changedFileNames` — the judge (and the pre-filter) never run for it.
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(0);
    expect(state.threads[0].status).toBe('done');
  });

  it('pre-filter: an all-docs/lockfile changed-file set skips the judge call entirely', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: false,
      reason: 'would gate if it were ever consulted',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['docs/guide.md', 'package-lock.json']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(0); // pre-filter classified it non-runtime without ever asking the judge
    expect(state.threads[0].status).toBe('done');
  });

  // ── Codex-requested regressions: the exact scenarios the original whole-job `origin/main...HEAD`
  // diff-signal design would have gotten wrong (see ADR 0005 §2c / the plan's "Diff-signal timing bug"). ──

  it('regression: a FIRST thread with an UNCOMMITTED new route file — the judge sees it (not an empty list)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = capturingJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'live curl evidence present',
    });
    const h = assemble(state, { judge });
    // `complete_thread` runs BEFORE `commitAll` — nothing has been committed yet when the judge is
    // consulted. `changedFileNames` is the only signal that would ever see this file at that moment.
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(1);
    expect(judge.seenChangedFiles[0]).toEqual(['src/routes/health.ts']); // NOT empty
  });

  it('regression: a SECOND docs-only thread after a prior runtime thread — its judge call sees ONLY its own changed files', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(), // 'sec-be' (Backend, ordinal 10) then 'sec-fe' (Frontend, ordinal 20)
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = capturingJudge({
      runtimeSurfaceTouched: false,
      liveVerificationAdequate: true,
      reason: 'non-runtime change',
    });
    const h = assemble(state, { judge });
    // Thread 1 (Backend) is mid-turn at `complete_thread` time — its own new runtime file. Thread 2
    // (Frontend) starts AFTER thread 1 committed, so its `sectionStartSha` (headSha) has advanced — the
    // fake writer turn bumps HEAD after `complete_thread`, so keying off `baseSha` isolates each thread's diff.
    stubChangedFileNames(h.git, async (_wt, baseSha) =>
      baseSha === 'sha0' ? ['src/routes/health.ts'] : ['notes/CONTRIBUTING.txt'],
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(judge.calls).toBe(2);
    // Thread 1's call saw its own runtime file; thread 2's call saw ONLY its own docs-ish file — never
    // thread 1's already-committed file. This is exactly what the per-thread `sectionStartSha` base
    // guarantees and a whole-job `origin/main...HEAD` diff would have gotten wrong (it would have shown
    // thread 2 the union of both threads' changes).
    expect(judge.seenChangedFiles[0]).toEqual(['src/routes/health.ts']);
    expect(judge.seenChangedFiles[1]).toEqual(['notes/CONTRIBUTING.txt']);
  });
});

describe('ThreadDriver — start_sha is captured once and RESUME-safe (the per-thread review base)', () => {
  it('FIRST execute: captures pre-build HEAD and set-once persists it as the thread start_sha', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'curl evidence present',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The pre-build HEAD ('sha0') was persisted set-once as this thread's review base.
    const ensure = h.store.ensureThreadStartSha as ReturnType<typeof vi.fn>;
    expect(ensure).toHaveBeenCalledWith('sec-be', 'sha0');
    expect(state.threads[0].startSha).toBe('sha0');
  });

  it('RESUME: a thread that already has start_sha reuses it — never re-captures against an already-advanced HEAD', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      // Simulate a resume: start_sha was persisted on the prior run and HEAD has since advanced past it (the
      // thread already committed). Re-capturing here would collapse `start..HEAD` to empty — the §1 bug that
      // silently skipped the review + mis-recorded the commit as `(nothing)`.
      threads: [{ ...thread('sec-be', 10, 'Backend'), startSha: 'base-sha' }],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const judge = fakeJudge({
      runtimeSurfaceTouched: true,
      liveVerificationAdequate: true,
      reason: 'curl evidence present',
    });
    const h = assemble(state, { judge });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The persisted base is reused verbatim — the set-once persist is never re-invoked, never overwritten.
    const ensure = h.store.ensureThreadStartSha as ReturnType<typeof vi.fn>;
    expect(ensure).not.toHaveBeenCalled();
    expect(state.threads[0].startSha).toBe('base-sha');
  });
});

// ── ADR 0004 Phase 3 — block_thread + brain auto-wake + bounded autonomous fix ─────────────────────

/** Production delivers the owed halt wake via the PERIODIC sweep (`startChatDeliverySweep` →
 *  `deliverOwedHaltWakes`), NOT inline from `drive()` — a live-validated fix (the inline wake fired ≈7s after
 *  the build turn and raced `dispatch_build`'s session rewrite → `error_during_execution`). Simulate the sweep
 *  in unit tests: wait for the halt to be recorded on the row, then fire `deliverOwedHaltWakes`. */
async function sweepDeliversWake(
  h: { driver: ThreadDriver; wakes: unknown[] },
  state: StoreState,
): Promise<void> {
  await flushUntil(() =>
    state.threads.some((t) => (t as HaltFields).halt_outcome != null),
  );
  // Let `drive()` FULLY exit (its `finally` clears the `active` guard) before the sweep fires — production
  // runs the sweep on a 30s timer, long after any drive settled, so a `retry_thread`→`redriveThread` in the
  // wake re-enters cleanly. Firing while `drive` is still unwinding would hit the `active` no-op.
  await flush();
  await h.driver.deliverOwedHaltWakes();
  await flushUntil(() => h.wakes.length > 0);
}

describe('ThreadDriver — ADR 0004 Phase 3 (block_thread + brain auto-wake + bounded fix)', () => {
  it('block_thread → blocked outcome → halts (job stays running, thread executing+paused, no PR) and wakes the brain ONCE', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const { turn } = makeTurn({
      blockThread: { reason: 'needs_env', detail: 'STRIPE_KEY is not granted to the sandbox' },
    });
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    // The typed voluntary halt flowed through the existing blocked plumbing — the STEP stays at 'executing'
    // and the pause is carried on the condition overlay:
    expect(state.threads[0].status).toBe('executing');
    expect(state.threads[0].condition).toBe('paused');
    expect(state.job.status).toBe('running'); // blocked leaves the job running (not paused/failed)
    expect(h.opened).toHaveLength(0); // nothing shipped
    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null })
      .terminal_record;
    expect(term?.status).toBe('blocked');
    expect(term?.blocked?.reason).toBe('needs_env');
    // A durable "Thread blocked" card was relayed:
    expect(h.posts.some((p) => p.includes('Thread blocked'))).toBe(true);
    // The brain was woken EXACTLY once, for this thread, with the outcome:
    expect(h.wakes).toEqual([
      { jobId: state.job.id, threadId: 'sec-be', outcome: 'blocked' },
    ]);
  });

  it('the wake fires only AFTER the job leaves the active window (a redrive from the wake would no-op otherwise)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const { turn } = makeTurn({
      blockThread: { reason: 'decision', detail: 'needs a call on the retry policy' },
    });
    // Assert `active` is clear at wake time by having the stub brain, on wake, attempt a redrive and confirm
    // it is NOT rejected by the active guard (i.e. it actually re-enters drive).
    const h = assemble(state, { turn });
    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);
    // A redrive issued right after the wake succeeds (job flips back to running from awaiting_input path):
    await h.driver.redriveThread(state.job.id, 'sec-be', 'grant the env and retry');
    await flushUntil(
      () => (state.threads[0].orientation ?? '') === 'grant the env and retry',
    );
    expect(state.threads[0].orientation).toBe('grant the env and retry');
  });

  it('is idempotent: a re-run of deliverOwedHaltWakes after a wake does NOT re-fire (dedup marker)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const { turn } = makeTurn({
      blockThread: { reason: 'question', detail: 'which API version?' },
    });
    const h = assemble(state, { turn });
    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);
    expect(h.wakes).toHaveLength(1);
    // Re-running the owed-wake sweep (as the boot sweep would) finds nothing owed — already stamped.
    await h.driver.deliverOwedHaltWakes(state.job.id);
    await flush();
    expect(h.wakes).toHaveLength(1); // NOT re-fired
  });

  it('terminal latch: a stray complete_thread AFTER block_thread does not overwrite the blocked assertion', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // A misbehaving turn that blocks, THEN tries to also complete — the latch must reject the second call.
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const tools = input.toolBridge?.tools;
          if (tools?.['block_thread']) {
            const first = await tools['block_thread']({
              reason: 'decision',
              detail: 'needs a design call',
            });
            const second = await tools['complete_thread']?.({ summary: 'sneaky done' });
            // The latch rejects the second assertion:
            expect((second as { ok?: boolean })?.ok).toBe(false);
            expect((first as { ok?: boolean })?.ok).toBe(true);
          }
          return {
            report: 'blocked step',
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null })
      .terminal_record;
    expect(term?.status).toBe('blocked'); // NOT overwritten to done
    expect(term?.blocked?.reason).toBe('decision');
  });

  it('terminal latch: a REPEAT block_thread (same assertion) is idempotent (ok:true + stop directive), not a retryable error', async () => {
    // ANTI-SPIN: a model that re-calls the terminal tool after latching must NOT get a bare error it reads as
    // "retry" (that spins the turn to PHASE_TIMEOUT). A same-kind repeat succeeds idempotently and is told to
    // STOP; the FIRST assertion's record is never overwritten.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const tools = input.toolBridge?.tools;
          if (tools?.['block_thread']) {
            const first = await tools['block_thread']({ reason: 'decision', detail: 'needs a design call' });
            const second = await tools['block_thread']({ reason: 'decision', detail: 'needs a design call' });
            expect((first as { ok?: boolean })?.ok).toBe(true);
            // Idempotent success, NOT an error — and it tells the model to stop:
            expect((second as { ok?: boolean; alreadyRecorded?: boolean })?.ok).toBe(true);
            expect((second as { alreadyRecorded?: boolean })?.alreadyRecorded).toBe(true);
            expect((second as { message?: string })?.message).toMatch(/stop|end your turn/i);
          }
          return {
            report: 'blocked step',
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record;
    expect(term?.status).toBe('blocked');
    expect(term?.blocked?.detail).toBe('needs a design call'); // the first assertion, unmodified
  });

  it('rejects block_thread with an invalid reason (unverified is host-only) or a missing detail', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const captured: Array<{ ok?: boolean; error?: string }> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const block = input.toolBridge?.tools?.['block_thread'];
          if (block) {
            captured.push((await block({ reason: 'unverified', detail: 'x' })) as never);
            captured.push((await block({ reason: 'needs_env', detail: '' })) as never);
            // A valid one so the thread still asserts a terminal state (else it'd be incomplete).
            await block({ reason: 'needs_env', detail: 'missing DB url' });
          }
          return {
            report: 'blocked',
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    expect(captured[0].ok).toBe(false); // 'unverified' rejected (host-only reason)
    expect(captured[1].ok).toBe(false); // missing detail rejected
  });

  it('redriveThread: clears the record + halt, injects guidance into orientation, and re-drives to completion', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // First turn blocks; after the operator/brain re-drives with guidance, the SAME thread completes.
    let blockedOnce = false;
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const tools = input.toolBridge?.tools;
          if (!blockedOnce && tools?.['block_thread']) {
            blockedOnce = true;
            await tools['block_thread']({ reason: 'needs_env', detail: 'missing key' });
          } else if (tools?.['complete_thread']) {
            await tools['complete_thread']({ summary: 'built after guidance' });
          }
          // The diagnostics done-gate turn exposes ONLY report_verification — report clean so it passes.
          if (tools?.['report_verification']) {
            await tools['report_verification']({ passed: true });
          }
          return {
            report: 'step',
            session: {
              id: 'sess',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    // Wait for the WAKE (fired once the job leaves the active window) — the real precondition for a redrive,
    // since the brain re-drives FROM the wake turn. Redriving before then would hit the `active` guard.
    await sweepDeliversWake(h, state);
    expect(
      (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record
        ?.status,
    ).toBe('blocked');

    // The brain re-drives with guidance (what retry_thread does after claiming the budget).
    await h.driver.redriveThread(state.job.id, 'sec-be', 'the key is granted now — retry the build');
    await flushUntil(() => state.job.status === 'done');

    expect(state.threads[0].orientation).toBe(
      'the key is granted now — retry the build',
    ); // guidance populated the dead orientation hook
    expect(state.job.status).toBe('done'); // shipped after the fix
  });

  it('redriveThread clears a stale condition before the asynchronous drive observes the row', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    vi.spyOn(
      h.driver as unknown as { drive: (jobId: string) => Promise<void> },
      'drive',
    ).mockResolvedValue(undefined);

    const result = await h.driver.redriveThread(state.job.id, 'sec-be', 'retry now');

    expect(result.ok).toBe(true);
    expect(state.threads[0].status).toBe('executing');
    expect(state.threads[0].condition).toBe('none');
    expect(h.store.setThreadCondition).toHaveBeenCalledWith('sec-be', 'none');
  });

  it('a Phase-2 judge DOWNGRADE does NOT latch — the orchestrator adds evidence and re-completes in the same turn', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // Judge downgrades the FIRST complete_thread (no live evidence), accepts the SECOND (evidence captured).
    let jc = 0;
    const judge: LiveVerificationJudge & { calls: number } = {
      calls: 0,
      async judge() {
        this.calls++;
        jc++;
        return jc === 1
          ? { runtimeSurfaceTouched: true, liveVerificationAdequate: false, reason: 'no live evidence yet' }
          : { runtimeSurfaceTouched: true, liveVerificationAdequate: true, reason: 'live 200 captured' };
      },
    };
    const returns: Array<Record<string, unknown>> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const ct = input.toolBridge?.tools?.['complete_thread'];
          if (ct) {
            returns.push((await ct({ summary: 'built endpoint' })) as Record<string, unknown>);
            // The judge warned; capture real evidence and re-complete — MUST NOT be latch-rejected.
            returns.push(
              (await ct({
                summary: 'built endpoint',
                verification: [{ kind: 'live', command: 'curl :4002/x', exitCode: 0, outputTail: 'HTTP 200' }],
              })) as Record<string, unknown>,
            );
          }
          if (input.toolBridge?.tools?.['report_verification']) {
            await input.toolBridge.tools['report_verification']({ passed: true });
          }
          return {
            report: 'built',
            session: {
              id: 'sess', jobId: input.jobId, stepId: input.stepId ?? null,
              engine: 'claude' as const, mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b', worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn, judge });
    stubChangedFileNames(h.git, async () => ['src/routes/x.ts']); // runtime file → judge runs

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The 2nd complete_thread was NOT rejected by the latch (it reached the judge and was accepted):
    expect(String(returns[1]?.['error'] ?? '')).not.toContain('already asserted');
    expect(judge.calls).toBe(2);
    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record;
    expect(term?.status).toBe('done'); // recovered in-turn, not falsely stuck blocked
    expect(state.job.status).toBe('done');
  });

  it('bounces the FIRST complete_thread when the checklist has an open task; the retry latches done once the model closes it', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as { tasks?: TaskItem[] }).tasks = [
      { id: 'x1', subject: 'Add tests', status: 'in_progress' },
    ];
    const returns: Array<Record<string, unknown>> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: { mode: string; stepId?: string | null; jobId: string; toolBridge?: ToolBridgeOptions }) => {
          const ct = input.toolBridge?.tools?.['complete_thread'];
          if (ct) {
            returns.push((await ct({ summary: 'built the backend' })) as Record<string, unknown>);
            // The model heeds the one reminder and closes its task (its TaskUpdate folds onto threads.tasks)…
            (state.threads[0] as { tasks?: TaskItem[] }).tasks = [
              { id: 'x1', subject: 'Add tests', status: 'completed' },
            ];
            // …then re-asserts done — must reach the gate this time, not be nudged again.
            returns.push((await ct({ summary: 'built the backend' })) as Record<string, unknown>);
          }
          return {
            report: 'built',
            session: {
              id: 'sess', jobId: input.jobId, stepId: input.stepId ?? null,
              engine: 'claude' as const, mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b', worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });
    stubChangedFileNames(h.git, async () => ['README.md']); // non-runtime → the done-gates short-circuit

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(String(returns[0]?.['warning'] ?? '')).toContain('open item'); // 1st: reminder, not latched
    expect(returns[1]?.['warning']).toBeUndefined(); // 2nd: no second nudge — proceeded to the gate
    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record;
    expect(term?.status).toBe('done');
    expect(state.job.status).toBe('done');
    // The model closed its own task, so the host had nothing to drop — it stays `completed`, not `dropped`.
    const tasks = (state.threads[0] as { tasks?: TaskItem[] }).tasks ?? [];
    expect(tasks.map((t) => t.status)).toEqual(['completed']);
  });

  it('accepts a re-asserted done with tasks STILL open, and the host flips the leftovers to `dropped` (not completed)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as { tasks?: TaskItem[] }).tasks = [
      { id: 'x1', subject: 'Add tests', status: 'in_progress' },
      { id: 'x2', subject: 'Update docs', status: 'pending' },
    ];
    const returns: Array<Record<string, unknown>> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: { mode: string; stepId?: string | null; jobId: string; toolBridge?: ToolBridgeOptions }) => {
          const ct = input.toolBridge?.tools?.['complete_thread'];
          if (ct) {
            // First → nudged; second → still open, but accepted (never wedge a validated thread).
            returns.push((await ct({ summary: 'built the backend' })) as Record<string, unknown>);
            returns.push((await ct({ summary: 'built the backend' })) as Record<string, unknown>);
          }
          return {
            report: 'built',
            session: {
              id: 'sess', jobId: input.jobId, stepId: input.stepId ?? null,
              engine: 'claude' as const, mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b', worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });
    stubChangedFileNames(h.git, async () => ['README.md']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(String(returns[0]?.['warning'] ?? '')).toContain('open item');
    expect(returns[1]?.['warning']).toBeUndefined();
    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record;
    expect(term?.status).toBe('done');
    expect(h.store.dropOpenThreadTasks).toHaveBeenCalledWith('sec-be');
    // Both stragglers flipped to `dropped` — the host never claims they were completed.
    const tasks = (state.threads[0] as { tasks?: TaskItem[] }).tasks ?? [];
    expect(tasks.map((t) => t.status)).toEqual(['dropped', 'dropped']);
    expect(state.job.status).toBe('done');
  });

  it('a REATTACHED diagnostics done-gate recovers its report_verification verdict from the replayed events log (never falsely halts)', async () => {
    // REGRESSION: the gate verdict lives only in an in-process closure fed by the consume-once/acked
    // tools-bridge channel. When the gate turn engine-detaches AFTER `report_verification({passed:true})` and
    // is REATTACHED on the next boot, that channel does NOT redeliver the call — but the authoritative events
    // log IS replayed. The driver must recover the verdict from the replayed `tool_use` event; otherwise it
    // falsely halts with "…without calling report_verification" and burns the brain's retry budget.
    const steps: Step[] = [
      {
        id: 'sec-be-ph0',
        threadId: 'sec-be',
        jobId: 'job-abcdef12',
        ordinal: 10,
        title: 'Backend',
        brief: 'Backend',
        stage: 'build' as const,
        status: 'building' as StepStatus,
        sessionId: 'sess-live', // persisted → gate's `canReattach() && anchor.sessionId` reattach lookup fires
        batchOrdinal: 1,
        legOrdinal: 1,
        commitSha: null,
      },
    ];
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps,
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };

    // The batch turn completes normally; the GATE turn is served via `reattach` (a live gate row exists).
    const runTurn = vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        toolBridge?: ToolBridgeOptions;
      }) => {
        await input.toolBridge?.tools?.['complete_thread']?.({ summary: 'built the backend' });
        return {
          report: 'built',
          session: {
            id: 'sess-live', jobId: input.jobId, stepId: input.stepId ?? null,
            engine: 'claude' as const, mode: input.mode as 'plan' | 'execute' | 'review',
            branch: 'b', worktreePath: '/wt/b',
          },
        };
      },
    );
    // The reattach REPLAYS the pre-detach `report_verification` tool_use (main agent, qualified MCP name) but
    // deliberately does NOT drive `toolBridge.tools.report_verification` itself — mirroring the acked channel
    // that never redelivers. So the ONLY way the verdict can be recovered (and the job reach `done`) is the
    // fix replay-driving the handler from this event.
    const reattach = vi.fn(async (input: Parameters<TurnRunnerService['reattach']>[0]) => {
      // The replayed `tool_use` carries `block.input` VERBATIM — the model's FLAT payload against the tool's
      // real per-tool schema (strict-validated client-side, no `{ args }` wrapper). The replay path drives
      // the handler with it directly, exactly like the live dispatch.
      input.onEvent?.({
        kind: 'tool_use',
        id: 'rv-1',
        name: 'mcp__atlas-host-bridge__report_verification',
        input: { passed: true },
      });
      return {
        report: 'gate resumed',
        session: {
          id: 'sess-live', jobId: input.jobId, stepId: input.stepId ?? null,
          engine: 'claude' as const, mode: 'execute' as const, branch: 'b', worktreePath: '/wt/b',
        },
      };
    });
    const turn = { runTurn, reattach, canReattach: () => true } as unknown as TurnRunnerService;

    // A live GATE row (kind:'gate') keyed on the anchor — the gate's `findReattachableTurn(...,'gate')` finds
    // it; the batch's `findReattachableTurn(...,'step')` does NOT (kind mismatch), so the batch runs fresh.
    const listRunning = vi.fn(async () => [
      {
        turn_id: 'gate-turn-live',
        job_id: 'job-abcdef12',
        org_id: 'T1',
        channel: 'C1',
        lane: 'thread:sec-be',
        kind: 'gate',
        container_id: 'ctr-gate',
        status: 'running',
        ctx: { anchorStepId: 'sec-be-ph0' },
      },
    ]);
    const judge: LiveVerificationJudge & { calls: number } = {
      calls: 0,
      async judge() {
        return { runtimeSurfaceTouched: false, liveVerificationAdequate: true, reason: 'n/a' };
      },
    };

    const h = assemble(state, { turn, judge, turnRegistry: { listRunning } as never });
    stubChangedFileNames(h.git, async () => ['src/routes/x.ts']); // a changed .ts → the done-gate kicks

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The gate went through the REATTACH path (not a fresh runTurn); the verdict was recovered SOLELY from
    // the replayed `tool_use` event (the mock never drove the bridge tool itself).
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach.mock.calls[0][0]).toMatchObject({ turnId: 'gate-turn-live', containerId: 'ctr-gate' });
    // No false halt: the thread verified + committed and the job shipped.
    const term = (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }).terminal_record;
    expect(term?.status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('a plain re-drive of a BLOCKED thread RE-HALTS (never re-runs the orchestrator) and re-wakes the brain', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // Pre-seed an existing block (as a prior turn left it) + a stamped wake (already delivered once).
    (state.threads[0] as unknown as {
      terminal_record: ThreadTerminalRecord;
      halt_outcome: string;
      halt_waked_at: Date | null;
    }).terminal_record = { status: 'blocked', summary: 'needs env', blocked: { reason: 'needs_env', detail: 'missing KEY' } };
    const { turn, calls } = makeTurn();
    const h = assemble(state, { turn });

    // Simulate boot resume re-driving the still-`running` job.
    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    // The orchestrator was NOT re-run (no execute turn) — the thread just re-halted + re-woke the brain:
    expect(calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(state.threads[0].status).toBe('executing');
    expect(state.threads[0].condition).toBe('paused');
    expect(h.opened).toHaveLength(0); // nothing shipped
    expect(h.wakes.some((w) => w.threadId === 'sec-be' && w.outcome === 'blocked')).toBe(true);

    // But the BRAIN's redriveThread (clears the record first) DOES re-run it to completion:
    await h.driver.redriveThread(state.job.id, 'sec-be', 'KEY granted — retry');
    await flushUntil(() => state.job.status === 'done');
    expect(calls.filter((c) => c.mode === 'execute').length).toBeGreaterThan(0); // re-ran now
    expect(state.threads[0].orientation).toBe('KEY granted — retry');
    expect(state.job.status).toBe('done');
  });

  it('a plain re-drive of a BLOCKED master_review RE-HALTS too (the stale isMasterReview exemption is gone — job 43705139 runaway)', async () => {
    // REGRESSION: master_review was once exempt from the blocked short-circuit — harmless until Codex gained
    // `block_thread` (a2a06b2). After that, a master-review that blocked (e.g. the full test suite is red for a
    // reason outside its diff, so the green-build completion bar is unreachable) left the job `running`, and
    // every boot resume re-ran the WHOLE Codex review — an UNBOUNDED loop bypassing the brain's re-drive cap.
    // Now it re-halts like any other thread; only the brain's bounded `redriveThread` re-runs it.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [
        thread('sec-be', 10, 'Backend', 'done'),
        thread('review', 40, 'Master review', 'executing', /* isMasterReview */ true, 'paused'),
      ],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[1] as unknown as {
      terminal_record: ThreadTerminalRecord;
    }).terminal_record = {
      status: 'blocked',
      summary: 'full suite red',
      blocked: {
        reason: 'needs_env',
        detail: 'full `pnpm test` red from an unrelated EPERM in install-script-fetch-hook.spec.ts',
      },
    };
    const { turn, calls } = makeTurn();
    const h = assemble(state, { turn });

    // Simulate boot resume re-driving the still-`running` job.
    await h.driver.dispatch(state.job);
    await sweepDeliversWake(h, state);

    // The Codex review was NOT re-run (no execute turn) — the master_review just re-halted + re-woke the brain:
    expect(calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(state.threads[1].status).toBe('executing');
    expect(state.threads[1].condition).toBe('paused');
    expect(h.opened).toHaveLength(0); // nothing shipped
    expect(h.wakes.some((w) => w.threadId === 'review' && w.outcome === 'blocked')).toBe(true);
  });

  it('a blocked thread whose autonomous budget is EXHAUSTED rests the job (paused, no owed wake) instead of re-waking forever', async () => {
    // Residual fix: once Atlas has spent its re-drive budget the block is waiting on the OPERATOR — leaving the
    // job `running` made every boot re-wake the brain to re-hit the same refusal. Now the driver rests it.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record = {
      status: 'blocked',
      summary: 'needs env',
      blocked: { reason: 'needs_env', detail: 'missing KEY' },
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 2; // budget already spent (cap = 2)
    const { turn, calls } = makeTurn();
    const h = assemble(state, { turn });

    // Simulate boot resume re-driving the still-`running` job.
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'budget_exhausted');

    // No orchestrator re-run, the job is RESTED (budget-exhausted halt), and NO wake was owed (halt_outcome
    // stays null → the sweeps have nothing to re-fire), so the brain is not re-woken to re-escalate a halt it
    // can't fix:
    expect(calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(state.job.halt?.kind).toBe('budget_exhausted');
    expect((state.threads[0] as unknown as HaltFields).halt_outcome ?? null).toBeNull();
    expect(h.wakes).toHaveLength(0);
  });

  it('operator RETRY re-arms the exhausted budget so Atlas gets fresh autonomous attempts', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as { terminal_record: ThreadTerminalRecord }).terminal_record = {
      status: 'blocked',
      summary: 'needs env',
      blocked: { reason: 'needs_env', detail: 'missing KEY' },
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 2;
    const { turn } = makeTurn();
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'budget_exhausted');
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(2);

    // The operator's explicit retry re-grants the budget (boot resume never would). Poll until dispatch's
    // drive releases the in-flight `active` lock so the retry lands rather than no-opping.
    for (
      let i = 0;
      i < 50 && (state.threads[0] as unknown as HaltFields).halt_fix_attempts !== 0;
      i++
    ) {
      await h.driver.retry(state.job.id);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(0);
  });

  it('redriveThread REFUSES a threadId belonging to another job (Codex High-1) — no budget, no mutation, no drive', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 0;
    const h = assemble(state);
    // Call with a jobId that is NOT the thread's owner (a hallucinated / cross-job threadId).
    const r = await h.driver.redriveThread('some-other-job', 'sec-be', 'guidance', 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not part of this job/i);
    // The thread was NOT mutated (orientation untouched) and NO budget was spent:
    expect(state.threads[0].orientation).toBeNull();
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(0);
  });

  it('redriveThread REFUSES an already-done thread — no budget, no mutation, no drive (won\'t resurrect a completed thread)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'done')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 0;
    const h = assemble(state);
    // A stale `retry_thread` (the brain acting on an old view) must not clear the record + flip the finished
    // thread back to `executing` — that would erase the `done` evidence and re-run a completed thread.
    const r = await h.driver.redriveThread(state.job.id, 'sec-be', 'stale retry', 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already complete/i);
    // Untouched: status still done, no terminal-record clear, no `executing` flip, no budget spent, no drive.
    expect(state.threads[0].status).toBe('done');
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(0);
    expect(state.threads[0].orientation).toBeNull();
    expect(h.store.clearTerminalRecord).not.toHaveBeenCalled();
  });

  it('redriveThread refuses (no budget spent) once the re-drive cap is hit (Codex High-2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'executing', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 2; // already at cap
    const h = assemble(state);
    const r = await h.driver.redriveThread(state.job.id, 'sec-be', 'guidance', 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/budget exhausted/i);
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(2); // CAS did not increment
    expect(state.threads[0].orientation).toBeNull(); // not mutated
  });

  it('renderCompletionMd projects the record into a readable trail (blocked + failed shapes)', () => {
    const t = thread('sec-be', 10, 'Backend');
    const blockedMd = renderCompletionMd(
      t,
      'blocked',
      {
        status: 'blocked',
        summary: 'could not reach the DB',
        blocked: { reason: 'needs_env', detail: 'DATABASE_URL missing' },
        gaps: ['no live check run'],
      } as ThreadTerminalRecord,
      '2026-07-04T00:00:00.000Z',
    );
    expect(blockedMd).toContain('# Thread halted: Backend');
    expect(blockedMd).toContain('**Outcome:** blocked');
    expect(blockedMd).toContain('needs_env');
    expect(blockedMd).toContain('DATABASE_URL missing');
    expect(blockedMd).toContain('no live check run');

    const incompleteMd = renderCompletionMd(t, 'incomplete', null, '2026-07-04T00:00:00.000Z');
    expect(incompleteMd).toContain('**Outcome:** incomplete');
    expect(incompleteMd).toContain('without asserting completion');
  });

  it('renderCompletionMd renders the Transcript line from the resolved anchor (even with a null record)', () => {
    const t = thread('sec-be', 10, 'Backend');
    const md = renderCompletionMd(t, 'incomplete', null, '2026-07-04T00:00:00.000Z', {
      sessionId: 'sess-xyz',
      legOrdinal: 3,
    });
    expect(md).toContain('**Transcript:** session `sess-xyz` (Leg 3)');
    expect(md).toContain('atlas-tx show sess-xyz');
  });
});

// ── async helpers ────────────────────────────────────────────────────────────────────────────────

/** Let the fire-and-forget drive settle — drains microtasks AND macrotasks across many ticks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Spin the event loop until a predicate holds (or a cap), for the pause/resume cases. */
async function flushUntil(pred: () => boolean, cap = 300): Promise<void> {
  for (let i = 0; i < cap; i++) {
    if (pred()) return;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ── ship-review gate: park a reviewed build for the operator's "Ship it" before opening the PR ──────

describe('ThreadDriver — ship-review gate (human approval before the PR)', () => {
  function baseState(job = makeJob({ shipReviewApprovedAt: null })): StoreState {
    return {
      job,
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }

  it('parks a feature build at awaiting_ship_review after the threads finish — no PR yet', async () => {
    const state = baseState();
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'awaiting_ship_review');

    expect(state.job.status).toBe('awaiting_ship_review');
    expect(h.store.parkForShipReview).toHaveBeenCalled();
    // The build fully ran (all threads done) but NOTHING shipped — no PR seed, job not done.
    expect(state.threads.every((s) => s.status === 'done')).toBe(true);
    expect(h.shipSeeds).toHaveLength(0);
    expect(state.job.prUrl).toBeNull();
  });

  it('ships once the operator approves — resolveShipApprovalDurably re-drives to the PR', async () => {
    const state = baseState();
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'awaiting_ship_review');

    const acted = await h.driver.resolveShipApprovalDurably(state.job.id, 'dennis');
    expect(acted).toBe(true);
    await flushUntil(() => state.job.status === 'done');

    expect(state.job.shipReviewApprovedAt).toBeInstanceOf(Date);
    expect(h.shipSeeds).toEqual([
      { jobId: state.job.id, branch: 'atlas/feature-job-abcd' },
    ]);
    // The re-drive fast-forwarded the already-done threads — it did NOT re-execute or re-review them.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(2);
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(2);
  });

  it('a second (stale/double) ship approval is a no-op once the job has shipped', async () => {
    const state = baseState();
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'awaiting_ship_review');
    await h.driver.resolveShipApprovalDurably(state.job.id, 'dennis');
    await flushUntil(() => state.job.status === 'done');

    const again = await h.driver.resolveShipApprovalDurably(state.job.id, 'dennis');
    expect(again).toBe(false);
  });

  it('does NOT gate an event-kind build — it ships straight through', async () => {
    const state = baseState(makeJob({ kind: 'event', shipReviewApprovedAt: null }));
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.store.parkForShipReview).not.toHaveBeenCalled();
    expect(h.shipSeeds).toHaveLength(1);
  });

  it('does NOT gate or ship a brain-owned DIRECT build (no driver-executable threads) — the driver yields', async () => {
    // A direct build persists ONLY a render-only `main` thread (zero builder/master_review), implements and
    // opens its own PR via `finalize_build` — the driver never ships it. A reconciler re-drive (boot
    // `resume()`, `retry`) of the still-`running` job sends it through `runJob`; the guard must yield rather
    // than fall through the empty thread loop to the ship gate (which would wrongly PARK it at
    // awaiting_ship_review + post a bogus "Ship it" card) or re-ship it. `dispatch` stands in for any
    // `drive()` entry point here (the guard sits in `runJob`, shared by all of them).
    const mainThread: DriverThread = {
      id: 'main-1',
      jobId: 'job-abcdef12',
      orgId: 'T1',
      ordinal: 0,
      brief: 'Main',
      plan: null,
      orientation: null,
      handoffIn: null,
      handoffOut: null,
      status: 'pending',
      condition: 'none',
      kind: 'main',
      parentThreadId: null,
      startSha: null,
    };
    const state = baseState();
    state.threads = [mainThread];
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flush();

    expect(h.store.parkForShipReview).not.toHaveBeenCalled();
    expect(h.shipSeeds).toHaveLength(0);
    expect(state.job.status).toBe('running');
    expect(state.job.prUrl).toBeNull();
  });
});

// ── 401 auth recovery: pause (not fail) + ping-to-resume the SAME session, durable ─────────────────

describe('ThreadDriver — 401 auth recovery', () => {
  /** A turn that throws EngineAuthError on the FIRST execute (a mid-build 401), then succeeds. */
  function flakyAuthTurn(): TurnRunnerService {
    let executes = 0;
    return {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          if (++executes === 1) {
            throw new EngineAuthError('401 Invalid API key', 'sess-401');
          }
          await assertThreadDone(input);
          return {
            report: `did ${input.stepId}`,
            session: {
              id: 'sess-401',
              jobId: input.jobId,
              stepId: input.stepId ?? null,
              engine: 'claude' as const,
              mode: input.mode as 'plan' | 'execute' | 'review',
              branch: 'b',
              worktreePath: '/wt/b',
            },
          };
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
  }

  function freshState(): StoreState {
    return {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }

  it('a mid-build 401 PAUSES the job (not fails); a ping resumes it to ONE PR', async () => {
    const state = freshState();
    const h = assemble(state, { turn: flakyAuthTurn() });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'blocked_credentials');

    expect(state.job.halt?.kind).toBe('blocked_credentials'); // halted, NOT 'failed'
    expect(state.job.prUrl).toBeNull();
    expect(h.posts.some((p) => p.toLowerCase().includes('paused'))).toBe(true);

    // Boot reconciliation must NOT auto-retry a credential-halted job (it would just 401 again).
    await h.driver.resume();
    await flushUntil(() => false, 5);
    expect(state.job.halt?.kind).toBe('blocked_credentials');

    // PING → resume the SAME session → drive to completion (one PR).
    await h.driver.resumePaused(state.job.id);
    await flushUntil(() => state.job.status === 'done');

    expect(state.job.status).toBe('done');
    expect(
      h.shipSeeds.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('resumePaused is a no-op when the job is not paused', async () => {
    const state = freshState();
    state.job.status = 'running';
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    expect(state.job.status).toBe('running'); // the ping itself does not flip a non-paused job
  });
});

describe('shortReason', () => {
  it('surfaces a child_process exec error\'s real stderr, not just "Command failed: <cmd>"', () => {
    // Exactly Node's promisified execFile/exec rejection shape: `.message` is "Command failed: <cmd>\n<stderr>".
    const err = new Error(
      "Command failed: git -C /repo add -A\nfatal: cannot change to '/repo': No such file or directory\n",
    );
    expect(shortReason(err)).toBe(
      "Command failed: git -C /repo add -A | fatal: cannot change to '/repo': No such file or directory",
    );
  });

  it('returns a plain single-line message unchanged', () => {
    expect(shortReason(new Error('econnreset'))).toBe('econnreset');
  });

  it('caps pathologically long messages instead of dumping a stack trace worth of text', () => {
    const err = new Error(`Command failed: x\n${'y'.repeat(600)}`);
    const out = shortReason(err);
    expect(out.length).toBe(500);
    expect(out.endsWith('...')).toBe(true);
  });

  it('falls back to String(err) for a non-Error throw', () => {
    expect(shortReason('boom')).toBe('boom');
  });
});

// ── Codex master-review live task list (parity with Claude Code's TaskCreate/TaskUpdate) ──────────────

describe('ThreadDriver — master-review bridged task list', () => {
  function baseState(): StoreState {
    return {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('mr', 90, 'Master review', 'executing', true)],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }
  // buildTurnBridge is private; reach it directly to assert the exposed tool surface + folds (a full
  // master-review drive is exercised elsewhere; here we isolate the task-bridge behavior).
  function bridgeFor(h: ReturnType<typeof assemble>, t: DriverThread) {
    // The task tools don't touch the deadline; a bare stub satisfies the (private) param type.
    const deadline = { pause() {}, resume() {}, signal: undefined };
    const sandbox: FeatureSandbox = {
      repoId: 'proj',
      branch: 'b',
      worktreePath: '/wt/b',
      gitUrl: REPO.gitUrl,
    };
    return (
      h.driver as unknown as {
        buildTurnBridge: (
          job: Job,
          thread: DriverThread,
          route: unknown,
          deadline: unknown,
          sandbox: FeatureSandbox,
          record: unknown,
          sectionStartSha: string | undefined,
        ) => ToolBridgeOptions;
      }
    ).buildTurnBridge(makeJob(), t, { channel: 'C1', threadTs: 't1' }, deadline, sandbox, null, 'sha0');
  }

  it('exposes task_create/task_update ONLY for the master-review thread', () => {
    const h = assemble(baseState());
    const mrTools = bridgeFor(h, thread('mr', 90, 'Master review', 'executing', true)).tools;
    expect(typeof mrTools.task_create).toBe('function');
    expect(typeof mrTools.task_update).toBe('function');
    // A Claude builder keeps its native SDK task tools — the bridge must NOT double them here.
    const builderTools = bridgeFor(h, thread('be', 10, 'Backend')).tools;
    expect(builderTools.task_create).toBeUndefined();
    expect(builderTools.task_update).toBeUndefined();
  });

  // Drift guard: every tool a turn bridge actually registers MUST have a TOOL_SHAPES entry, or the
  // Claude SDK bridge would silently strip every argument that tool's handler reads (a strict zod
  // object drops unknown keys before the handler ever sees them). The gate bridge (`buildGateToolBridge`)
  // is skipped here — it's heavier to construct and only adds `report_verification`, which this already
  // covers via the builder/master-review bridges.
  it('every buildTurnBridge()-registered tool (master-review + builder) has a TOOL_SHAPES entry', () => {
    const h = assemble(baseState());
    const masterReviewTools = bridgeFor(h, thread('mr', 90, 'Master review', 'executing', true)).tools;
    const builderTools = bridgeFor(h, thread('be', 10, 'Backend')).tools;
    for (const tools of [masterReviewTools, builderTools]) {
      for (const name of Object.keys(tools)) {
        expect(TOOL_SHAPES, `driver tool "${name}" must have a TOOL_SHAPES entry`).toHaveProperty(name);
      }
    }
  });

  it('folds task_create into the thread scope with sequential ids, and returns the id to the model', async () => {
    const h = assemble(baseState());
    const tools = bridgeFor(h, thread('mr', 90, 'Master review', 'executing', true)).tools;

    const r1 = await tools.task_create({ subject: 'Review the merged diff', activeForm: 'Reviewing the merged diff' });
    const r2 = await tools.task_create({ subject: 'Apply fixes' });
    await tools.task_update({ taskId: '1', status: 'in_progress' });

    // The create result carries the id (so the model can pass it back to task_update) — matching the
    // Claude SDK task tools' "Task #N created…" contract that `createdTaskId` parses.
    expect(r1).toBe('Task #1 created: Review the merged diff');
    expect(r2).toBe('Task #2 created: Apply fixes');

    // All folds landed on the master-review THREAD scope, via the same sink the Claude lanes use.
    expect(h.taskEvents.map((e) => [e.toolName, e.scope.kind, e.scope.id])).toEqual([
      ['taskcreate', 'thread', 'mr'],
      ['taskcreate', 'thread', 'mr'],
      ['taskupdate', 'thread', 'mr'],
    ]);
    // The create fold gets the id-bearing result string; the update fold carries the model's status change.
    expect(h.taskEvents[0].result).toBe('Task #1 created');
    expect(h.taskEvents[2].input).toMatchObject({ taskId: '1', status: 'in_progress' });
  });

  it('rejects a task_create with no subject and a task_update with no taskId (no fold)', async () => {
    const h = assemble(baseState());
    const tools = bridgeFor(h, thread('mr', 90, 'Master review', 'executing', true)).tools;
    expect(await tools.task_create({})).toMatchObject({ ok: false });
    expect(await tools.task_update({})).toMatchObject({ ok: false });
    expect(h.taskEvents).toHaveLength(0);
  });
});

// ── Leg rotation (context-rot mitigation): fat builder session → handoff → fresh Leg continues ──────

describe('ThreadDriver — Leg rotation (context-rot mitigation)', () => {
  /** Stateful Leg-rotation store overlay on the default fake: `completeLegRotation` stashes the seed (which
   *  `getPendingLegSeed` then returns so the fresh Leg's task carries it) and reports the leg transition. */
  function wireRotationStore(h: ReturnType<typeof assemble>): { rotations: () => number } {
    let seed: string | null = null;
    let rotations = 0;
    (h.store.getPendingLegSeed as ReturnType<typeof vi.fn>).mockImplementation(async () => seed);
    (h.store.completeLegRotation as ReturnType<typeof vi.fn>).mockImplementation(
      async (inp: { seed: string }) => {
        rotations += 1;
        seed = inp.seed;
        return { fromLeg: 1, toLeg: 2, abandonedSessionId: 'sess-fat' };
      },
    );
    return { rotations: () => rotations };
  }

  function mkResult(input: { jobId: string; stepId?: string | null; mode: string }, report: string) {
    return {
      report,
      session: {
        id: 'sess',
        jobId: input.jobId,
        stepId: input.stepId ?? null,
        engine: 'claude' as const,
        mode: input.mode as 'plan' | 'execute' | 'review',
        branch: 'b',
        worktreePath: '/wt/b',
      },
    };
  }

  it('rotates when the builder SELF-authors a handoff (record_leg_handoff), then the fresh Leg continues from the seed', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')], // ONE builder thread (single batch)
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };

    const capturedTasks: string[] = [];
    let buildLeg = 0;
    const runTurn = vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        task: string;
        steerable?: boolean;
        toolBridge?: ToolBridgeOptions;
        onEvent?: (e: { kind: string; [k: string]: unknown }) => void;
      }) => {
        // Gate turn (diagnostics done-gate) — report clean and return; NOT a build Leg.
        if (input.toolBridge?.tools?.['report_verification']) {
          await input.toolBridge.tools['report_verification']({ passed: true });
          return mkResult(input, 'gate ok');
        }
        capturedTasks.push(input.task);
        buildLeg += 1;
        if (buildLeg === 1) {
          // Leg 1: the batch turn IS steerable (armed), and it exposes the handoff tool. Simulate the context
          // filling past the soft threshold, then the model self-authoring its handoff and YIELDING (no complete_thread).
          expect(input.steerable).toBe(true);
          expect(input.toolBridge?.tools?.['record_leg_handoff']).toBeTypeOf('function');
          input.onEvent?.({ kind: 'usage', contextTokens: 210_000, contextLimit: 1_000_000 });
          const ack = await input.toolBridge!.tools!['record_leg_handoff']!({
            handoff:
              'Scope: edited src/foo.ts (WIP).\nFAILED: `pnpm build` → TS2345 assign string to number.\nNext: finish the return type.',
          });
          expect(ack).toMatchObject({ ok: true }); // the tool tells the model to STOP
          return mkResult(input, 'leg 1 handed off');
        }
        // Leg 2 (fresh session, seeded): finish the batch.
        await input.toolBridge?.tools?.['complete_thread']?.({ summary: 'finished on the fresh Leg' });
        return mkResult(input, 'leg 2 done');
      },
    );
    const turn = { runTurn, canReattach: () => false, canSteer: () => false } as unknown as TurnRunnerService;

    const h = assemble(state, { turn });
    const rot = wireRotationStore(h);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Exactly one rotation happened, and TWO build Legs ran (Leg 1 handed off, Leg 2 finished).
    expect(rot.rotations()).toBe(1);
    expect(buildLeg).toBe(2);
    // The fresh Leg's task carried the rotation seed — the preamble wrapper AND the prior Leg's handoff (with
    // its verbatim FAILED-attempt error, which must survive the boundary), folded ahead of the base task.
    const freshTask = capturedTasks[1];
    expect(freshTask).toContain('<session_rotated>');
    expect(freshTask).toContain('FAILED: `pnpm build` → TS2345');
    expect(freshTask).toContain('\n\n---\n\n'); // seed folded ahead of the original batch task
    // Recency ordering: the handoff/preamble lead (PRIMACY, top), the original batch task sits in the middle, and
    // the operative resume directive trails LAST (RECENCY slot) — see foldLegSeed / ROTATION_RESUME_TAIL.
    const iPreamble = freshTask.indexOf('<session_rotated>');
    const iBaseTask = freshTask.indexOf('Feature overview:');
    const iResume = freshTask.indexOf('<resume_here>');
    expect(iResume).toBeGreaterThan(-1);
    expect(iPreamble).toBeLessThan(iBaseTask);
    expect(iBaseTask).toBeLessThan(iResume);
    // The thread + job finished cleanly on the fresh Leg.
    expect(state.threads[0].status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('NO FORCED ROTATION: a fat Leg that is nudged but never self-hands-off finishes WITHOUT rotating (and the nudge is a visible row)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };

    const modes: string[] = [];
    let buildLeg = 0;
    const runTurn = vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        task: string;
        toolBridge?: ToolBridgeOptions;
        onEvent?: (e: { kind: string; [k: string]: unknown }) => void;
      }) => {
        modes.push(input.mode);
        if (input.toolBridge?.tools?.['report_verification']) {
          await input.toolBridge.tools['report_verification']({ passed: true });
          return mkResult(input, 'gate ok');
        }
        buildLeg += 1;
        // The one build Leg runs fat (crosses soft → the engine-local nudge fires + the driver records a visible
        // row) but NEVER calls record_leg_handoff. Under no-forced-rotation it just finishes normally.
        input.onEvent?.({ kind: 'usage', contextTokens: 210_000, contextLimit: 1_000_000 });
        await input.toolBridge?.tools?.['complete_thread']?.({ summary: 'finished fat, no handoff' });
        return mkResult(input, 'leg 1 done fat');
      },
    );
    const turn = { runTurn, canReattach: () => false, canSteer: () => false } as unknown as TurnRunnerService;

    const h = assemble(state, { turn });
    const rot = wireRotationStore(h);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // No read-only fallback turn exists anymore, no rotation happened, and only ONE build Leg ran.
    expect(modes).not.toContain('review');
    expect(rot.rotations()).toBe(0);
    expect(h.store.completeLegRotation).not.toHaveBeenCalled();
    expect(buildLeg).toBe(1);
    // …but the SOFT nudge was mirrored into the transcript as a VISIBLE per-Leg harness row.
    expect(h.store.recordBuildSystemChunk).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system_reminder', legOrdinal: 1, phaseId: expect.any(String) }),
    );
    expect(state.job.status).toBe('done');
  });

  it('does NOT rotate a normal Leg that never crosses the threshold (single turn, no fallback)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state); // the DEFAULT build turn: asserts complete_thread, emits no usage events
    const rot = wireRotationStore(h);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(rot.rotations()).toBe(0);
    expect(h.store.completeLegRotation).not.toHaveBeenCalled();
    expect(state.job.status).toBe('done');
  });
});
