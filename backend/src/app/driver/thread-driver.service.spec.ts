import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BrainGateway } from '../brain-gateway';
import {
  EngineAuthError,
  EngineSessionLimitError,
  HOST_RETRY_BACKOFF_MS,
  MAX_HOST_RETRIES,
  NO_ENGINE_CREDENTIAL_MARKER,
} from '@shared/engine';
import type { EngineRunnerPort, ToolBridgeOptions } from '@shared/engine';
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
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
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
import type {
  BlockSink,
  ChatSurface,
  LiveTurnStore,
  TaskEventSink,
} from '../surface';
import { TurnHarnessFactory } from '../surface';
import type { SkillResolver, SkillNudgeSelector } from '../skills';
import type { CredentialResolver } from '../onboarding';
import type { ClaudeCredentialStore } from '../onboarding/claude-credential.store';
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
} from '@shared/domain';
import { CODEX_REVIEW_OUTAGE_RETRY_MS } from '@shared/domain';
import type { TaskItem, ThreadTerminalRecord } from '../persistence/entities';
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

interface StoreDriverThread extends DriverThread {
  config?: Record<string, unknown>;
}

interface StoreState {
  job: Job;
  record: DecisionRecord | null;
  threads: StoreDriverThread[];
  steps: Step[];
  route: JobRoute;
  operatorInputCards: OperatorInputCard[];
  systemNotices?: string[];
  /** A builder's materialized review children (review_agent + review_fix rows). Lazily created. */
  reviewChildren?: ReviewChildRow[];
  /** Persisted `thread_groups.config` keyed by group id — backs the skill-nudge read-after-write fakes. */
  threadGroupConfigs?: Record<string, Record<string, unknown>>;
}

function isFakeSkillNudge(
  value: unknown,
): value is { skills: { name: string; reason: string }[]; at: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.skills) || typeof record.at !== 'string')
    return false;
  return record.skills.every(
    (s) =>
      s != null &&
      typeof s === 'object' &&
      !Array.isArray(s) &&
      typeof (s as Record<string, unknown>).name === 'string' &&
      typeof (s as Record<string, unknown>).reason === 'string',
  );
}

function makeStore(state: StoreState): {
  store: DriverStoreService;
  state: StoreState;
} {
  let nextQuestionId = 1;
  // Durable retry-counter fakes (mirrors the real CAS columns on `jobs`): keyed by jobId, independent of
  // `state.job` since the domain `Job` shape doesn't expose these columns (store-internal only).
  const retryCounters = new Map<
    string,
    {
      auth: number;
      driverTransient: number;
      sessionLimitTextMisfires: number;
      lastAttemptAt: Date | null;
    }
  >();
  const retryCounterFor = (jobId: string) => {
    let c = retryCounters.get(jobId);
    if (!c) {
      c = {
        auth: 0,
        driverTransient: 0,
        sessionLimitTextMisfires: 0,
        lastAttemptAt: null,
      };
      retryCounters.set(jobId, c);
    }
    return c;
  };
  const threadIdForAnchor = (anchorId: string): string =>
    state.steps.find((step) => step.id === anchorId)?.threadId ?? anchorId;
  const threadGroupIdForThread = (thread: StoreDriverThread): string =>
    (thread.config?.threadGroupId as string | undefined) ?? `thread-group-${thread.id}`;
  const threadGroupKindForThread = (thread: StoreDriverThread): string =>
    thread.kind === 'master_review'
      ? 'master_review'
      : thread.kind === 'post_build' || thread.kind === 'ship'
        ? thread.kind
        : ((thread.config?.threadGroupKind as string | undefined) ?? 'section');
  const ensureSingletonThread = (input: {
    kind: 'post_build' | 'ship';
    brief: string;
  }): { threadGroupId: string; threadId: string } => {
    const existing = state.threads.find(
      (thread) =>
        thread.jobId === state.job.id &&
        thread.parentThreadId == null &&
        thread.kind === input.kind,
    );
    if (existing) {
      return { threadGroupId: threadGroupIdForThread(existing), threadId: existing.id };
    }
    const ordinal =
      Math.max(
        0,
        ...state.threads
          .filter((thread) => thread.parentThreadId == null)
          .map((thread) => thread.ordinal),
      ) + 10;
    const threadId = `${input.kind}-${state.job.id}`;
    const threadGroupId = `thread-group-${threadId}`;
    state.threads.push({
      id: threadId,
      jobId: state.job.id,
      orgId: state.job.orgId,
      ordinal,
      brief: input.brief,
      plan: null,
      orientation: null,
      handoffIn: null,
      handoffOut: null,
      status: 'idle',
      condition: 'none',
      kind: input.kind,
      threadGroupId,
      type: 'general',
      parentThreadId: null,
      startSha: null,
      config: { threadGroupId, threadGroupKind: input.kind },
    });
    return { threadGroupId, threadId };
  };
  const threadGroupsForJob = (jobId: string) =>
    state.threads
      .filter(
        (thread) =>
          thread.jobId === jobId &&
          thread.parentThreadId == null &&
          ['builder', 'master_review', 'post_build', 'ship'].includes(
            thread.kind,
          ),
      )
      .map((thread) => ({
        id: threadGroupIdForThread(thread),
        job_id: thread.jobId,
        org_id: thread.orgId,
        ordinal: thread.ordinal,
        kind: threadGroupKindForThread(thread),
        title: thread.kind === 'builder' ? thread.brief : null,
        type: thread.type,
        status: 'pending',
        condition: 'none',
        decision_record_id: state.job.decisionRecordId ?? null,
        config: {},
      }));
  const driverThreadsForThreadGroup = (threadGroupId: string) => {
    const parent = state.threads.find(
      (thread) => threadGroupIdForThread(thread) === threadGroupId,
    );
    if (!parent) return [];
    if (parent.kind === 'builder') {
      return state.threads
        .filter(
          (thread) =>
            thread.id === parent.id || thread.parentThreadId === parent.id,
        )
        .filter((thread) => thread.kind === 'builder')
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((thread) => ({ ...thread }));
    }
    return [{ ...parent }];
  };
  const store = {
    loadJob: vi.fn(async () => ({ ...state.job })),
    runningJobs: vi.fn(async () =>
      state.job.status === 'building' && state.job.halt == null
        ? [{ ...state.job }]
        : [],
    ),
    setJobStatus: vi.fn(async (_id: string, status: Job['status']) => {
      state.job.status = status;
    }),
    setFocusedThread: vi.fn(async (_id: string, _threadId: string) => undefined),
    recomputeBuildStageProgress: vi.fn(async (_id: string) => undefined),
    hasRecentSystemOperatorNotice: vi.fn(async (_id: string, text: string) => {
      return (state.systemNotices ?? []).includes(text);
    }),
    setSessionResume: vi.fn(async () => undefined),
    clearRetrySessionResume: vi.fn(async () => undefined),
    setFeatureBranch: vi.fn(async (_id: string, branch: string) => {
      state.job.featureBranch = branch;
    }),
    setPrReady: vi.fn(async (_id: string, prUrl: string) => {
      state.job.prUrl = prUrl;
      state.job.status = 'pr_open';
    }),
    // ── ship-review gate fakes ───────────────────────────────────────────────────────────────────────
    parkForShipReview: vi.fn(async (_id: string) => {
      if (state.job.status !== 'building') return false;
      state.job.status = 'ready';
      return true;
    }),
    approveShip: vi.fn(async (_id: string) => {
      if (state.job.status !== 'ready') return false;
      state.job.shipReviewApprovedAt = new Date();
      state.job.status = 'building';
      return true;
    }),
    clearShipApproval: vi.fn(async (_id: string) => {
      state.job.shipReviewApprovedAt = null;
    }),
    ensurePostBuildThread: vi.fn(async () =>
      ensureSingletonThread({
        kind: 'post_build',
        brief: 'Ship — open the PR',
      }),
    ),
    postBuildThreadId: vi.fn(async (jobId: string) => {
      const existing = state.threads.find(
        (thread) =>
          thread.jobId === jobId &&
          thread.parentThreadId == null &&
          thread.kind === 'post_build',
      );
      return existing?.id ?? null;
    }),
    ensureShipThread: vi.fn(async () =>
      ensureSingletonThread({
        kind: 'ship',
        brief: 'Ship',
      }),
    ),
    decisionRecord: vi.fn(async () => state.record),
    threadGroupsForJob: vi.fn(async (jobId: string) => threadGroupsForJob(jobId)),
    driverThreadsForThreadGroup: vi.fn(async (threadGroupId: string) =>
      driverThreadsForThreadGroup(threadGroupId),
    ),
    threadsForJob: vi.fn(async () => state.threads.map((s) => ({ ...s }))),
    getThread: vi.fn(async (id: string) => {
      const s = state.threads.find((x) => x.id === id);
      return s ? { ...s } : null;
    }),
    setThreadStatus: vi.fn(async (id: string, status: ThreadStatus) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.status = status;
      // Child rows (review_agent / review_fix) share this setter.
      const c = (state.reviewChildren ?? []).find((x) => x.id === id);
      if (c) c.status = status;
    }),
    setThreadCondition: vi.fn(
      async (id: string, condition: ThreadCondition) => {
        const s = state.threads.find((x) => x.id === id);
        if (s) s.condition = condition;
        // Child rows (review_agent / review_fix) share this setter.
        const c = (state.reviewChildren ?? []).find((x) => x.id === id);
        if (c) c.condition = condition;
      },
    ),
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
    // Review CHILD threads (post-build review as real rows). Materialize is idempotent; each agent/fix
    // is its own row with its own status + findings.
    materializeReviewChildren: vi.fn(
      async (
        parent: { id: string },
        childSpecs: Array<{
          kind: string;
          brief: string;
          config: Record<string, unknown>;
        }>,
      ) => {
        const kids = (state.reviewChildren ??= []);
        const existing = kids.filter((c) => c.parentId === parent.id);
        if (existing.length) return existing.map((c) => ({ ...c }));
        const created: ReviewChildRow[] = childSpecs.map((c, i) => ({
          id: `${parent.id}-child-${i}`,
          parentId: parent.id,
          kind: c.kind,
          brief: c.brief,
          ordinal: (i + 1) * 10,
          config: c.config,
          status: 'idle',
          condition: 'none',
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
        status: 'pending',
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
      return open
        ? { questionId: open.questionId, question: open.question }
        : null;
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
    readOperatorInputAnswer: vi.fn(
      async (_jobId: string, questionId: string) => {
        const card = state.operatorInputCards.find(
          (c) => c.questionId === questionId,
        );
        return card?.answer ?? null;
      },
    ),
    markOperatorInputDelivered: vi.fn(
      async (_jobId: string, questionId: string) => {
        const card = state.operatorInputCards.find(
          (c) => c.questionId === questionId,
        );
        if (card) card.delivered = true;
      },
    ),
    // ── typed terminal record (ADR 0004) — backed on the thread object so a "restart" (fresh driver, same
    //    state) preserves the assertion, exactly like the DB column. ────────────────────────────────────
    recordThreadTermination: vi.fn(
      async (threadId: string, terminal: ThreadTerminalRecord) => {
        const s = state.threads.find((x) => x.id === threadId);
        if (s)
          (
            s as { terminal_record?: ThreadTerminalRecord | null }
          ).terminal_record = terminal;
      },
    ),
    clearTerminalRecord: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      if (s)
        (
          s as { terminal_record?: ThreadTerminalRecord | null }
        ).terminal_record = null;
    }),
    getTerminalRecord: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      return (
        (s as { terminal_record?: ThreadTerminalRecord | null })
          ?.terminal_record ?? null
      );
    }),
    // Transcript anchor (halt-wake) — no steps/legs session seeded in these tests, so the anchor resolves
    // undefined; present so `writeCompletionMd` doesn't call an undefined fn.
    resolveSessionAnchor: vi.fn(async (_threadId: string) => undefined),
    // ── Leg rotation (context-rot mitigation) — no prior rotation in these tests, so the driver folds no seed
    //    and rotates ONLY on a self-authored handoff. `completeLegRotation` is present for the type only. ──
    getPendingLegSeed: vi.fn(async (anchorStepId: string) => {
      const s = state.threads.find(
        (x) => x.id === threadIdForAnchor(anchorStepId),
      );
      const seed = s?.config?.pendingLegSeed;
      return typeof seed === 'string' ? seed : null;
    }),
    completeLegRotation: vi.fn(async () => null),
    builderLegCountForThreadGroup: vi.fn(async (anchorThreadId: string) => {
      const current = state.threads.find(
        (x) => x.id === threadIdForAnchor(anchorThreadId),
      );
      if (!current) return 0;
      const rootId = current.parentThreadId ?? current.id;
      return state.threads.filter(
        (thread) =>
          thread.kind === 'builder' &&
          (thread.id === rootId || thread.parentThreadId === rootId),
      ).length;
    }),
    recordBuildSystemChunk: vi.fn(async () => undefined),
    getThreadTasks: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as
        | { tasks?: TaskItem[] }
        | undefined;
      return Array.isArray(s?.tasks) ? s.tasks : [];
    }),
    dropOpenThreadTasks: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId) as
        | { tasks?: TaskItem[] }
        | undefined;
      if (!Array.isArray(s?.tasks)) return 0;
      let dropped = 0;
      s.tasks = s.tasks.map((t) => {
        if (t.status === 'pending' || t.status === 'in_progress') {
          dropped++;
          return { ...t, status: 'dropped' as const };
        }
        return t;
      });
      return dropped;
    }),
    recordActiveLeg: vi.fn(async () => undefined),
    // Skill-nudge selection persisted on the build thread GROUP — a stateful bucket so a persist within a
    // test is readable back (the reuse path reads what an earlier leg wrote). A present key (even empty
    // skills) counts as "already decided".
    readGroupSkillNudge: vi.fn(async (threadGroupId: string) => {
      const v = state.threadGroupConfigs?.[threadGroupId]?.skillNudge;
      return isFakeSkillNudge(v) ? v : null;
    }),
    persistGroupSkillNudge: vi.fn(
      async (
        threadGroupId: string,
        nudge: { skills: { name: string; reason: string }[]; at: string },
      ) => {
        const buckets = (state.threadGroupConfigs ??= {});
        buckets[threadGroupId] = {
          ...(buckets[threadGroupId] ?? {}),
          skillNudge: nudge,
        };
      },
    ),
    getLegsForJob: vi.fn(async (_jobId: string) => []),
    threadJobId: vi.fn(async (threadId: string) => {
      const s = state.threads.find((x) => x.id === threadId);
      return s?.jobId ?? null;
    }),
    masterReviewThreadId: vi.fn(async (jobId: string) => {
      const s = state.threads.find(
        (x) => x.jobId === jobId && x.kind === 'master_review',
      );
      return s?.id ?? null;
    }),
    // ── durable retry-counter fakes (Thread 1: durable retry counters) ─────────────────────────────
    claimAuthRetryAttempt: vi.fn(async (jobId: string, cap: number) => {
      const c = retryCounterFor(jobId);
      if (c.auth >= cap) return { ok: false, used: cap };
      c.auth += 1;
      c.lastAttemptAt = new Date();
      return { ok: true, used: c.auth };
    }),
    claimDriverTransientRetry: vi.fn(async (jobId: string, cap: number) => {
      const c = retryCounterFor(jobId);
      if (c.driverTransient >= cap) return { ok: false, used: cap };
      c.driverTransient += 1;
      c.lastAttemptAt = new Date();
      return { ok: true, used: c.driverTransient };
    }),
    claimSessionLimitTextMisfire: vi.fn(async (jobId: string, cap: number) => {
      const c = retryCounterFor(jobId);
      if (c.sessionLimitTextMisfires >= cap) return { ok: false, used: cap };
      c.sessionLimitTextMisfires += 1;
      return { ok: true, used: c.sessionLimitTextMisfires };
    }),
    clearDriverRetryCounters: vi.fn(async (jobId: string) => {
      const c = retryCounterFor(jobId);
      c.auth = 0;
      c.driverTransient = 0;
      c.sessionLimitTextMisfires = 0;
    }),
    driverTransientRetryState: vi.fn(async (jobId: string) => {
      const c = retryCounterFor(jobId);
      return { count: c.driverTransient, lastAttemptAt: c.lastAttemptAt };
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
    // Empty by default; a test can override this to simulate a real runtime-touching diff.
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
    findOpenPullByHead: vi.fn(
      async (_token: string, args: { head: string }) => ({
        url: `https://github.com/acme/widget/pull/1`,
        number: 1,
        head: args.head,
      }),
    ),
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
    /** The message the simulated transient failure throws (default: a sandbox connection-reset blip). Lets a
     *  test drive a SPECIFIC transient shape — e.g. the d1 circuit-breaker's `in-sandbox engine turn failed:
     *  Error: engine stream closed …` — through the REAL `runJobWithTransientRetry`/`TRANSIENT_ERROR_RE`. */
    transientMessage?: string;
    /** VESTIGIAL: `block_thread` was removed from the real tool bridge (d2 — ending a turn without
     *  `complete_thread` IS the "needs operator" signal now). No test sets this option, so
     *  `input.toolBridge?.tools?.['block_thread']` below is always undefined and this branch never fires;
     *  left in place only as a harmless no-op rather than unpicking the (unused) option plumbing. */
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
          throw new Error(
            opts.transientMessage ??
              'sandbox exec failed: connection reset by peer',
          );
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
              {
                kind: 'test',
                command: 'pnpm test',
                exitCode: 0,
                outputTail: 'ok',
              },
            ],
          });
          // The writer committed + pushed before asserting completion — its in-sandbox commit advances HEAD,
          // which the host then reads to stamp `commit_sha`. Advancing here isolates each thread's diff base.
          advanceHead?.();
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
  const applyReviewFindings = vi.fn(async () => ({
    fixReport: '',
    commits: [],
  }));
  const ensureContextDiff = vi.fn(async (ctx: Record<string, unknown>) => ({
    ...ctx,
    diff: 'x',
    changedFiles: ['f.ts'],
  }));
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
    buildPath: 'plan',
    status: 'building',
    halt: null,
    decisionRecordId: 'dr-1',
    featureBranch: null,
    currentBranch: null,
    prUrl: null,
    prNumber: null,
    shipReviewApprovedAt: null,
    autoApproveMode: 'off',
    autoApproveBy: null,
    autoMerge: false,
    autoMergeBy: null,
    createdBy: null,
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
  status: ThreadStatus = 'idle',
  isMasterReview = false,
  condition: ThreadCondition = 'none',
  type: Thread['type'] = 'general',
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
    threadGroupId: `thread-group-${id}`,
    type,
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
    turnRegistry?: Pick<
      import('../sandbox/turn-registry.service').TurnRegistry,
      'listRunning'
    >;
    /** Override `CredentialResolver.anthropicKey` — defaults to the env-fallback shape (no key). */
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
    claudeCreds?: Pick<
      ClaudeCredentialStore,
      'getSelectedRefreshMeta' | 'markNeedsReauth'
    >;
    /** The manual "Merge PR" click's resolution path — defaults to a no-op resolve unless a test overrides it. */
    autoMerge?: Pick<
      import('./auto-merge.service').AutoMergeService,
      'mergeNow'
    >;
    /** The binding usage window's utilization for a TEXT-fallback session-limit hit's corroboration check
     *  (`OauthUsageService.getUtilization`) — defaults to `undefined` (uncorroborated). */
    usageUtilization?: number;
    /** Override `SkillResolver` so a test can surface build-surface skills the nudge selector picks from. */
    skillResolver?: Pick<
      SkillResolver,
      'resolveForTurn' | 'resolveReviewSkillsForThread'
    >;
    /** Override the Haiku skill-nudge selector — defaults to one that picks nothing. */
    skillNudgeSelector?: SkillNudgeSelector;
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
  const liveTurns = {
    push: vi.fn(),
    end: vi.fn(),
    retry: vi.fn(),
    snapshot: vi.fn(() => null),
  } as unknown as LiveTurnStore;
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
        if (
          (block.meta as { source?: unknown } | null)?.source ===
            'system_operator' &&
          block.text
        ) {
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
        block: {
          kind: string;
          text?: string;
          meta?: Record<string, unknown> | null;
        },
      ) => {
        if (
          sunk.some(
            (s) =>
              s.block.kind === 'agent_prompt' &&
              (s.block.meta as { promptKey?: string } | null)?.promptKey ===
                promptKey,
          )
        ) {
          return;
        }
        sunk.push({
          jobId,
          block: { ...block, meta: { ...(block.meta ?? {}), promptKey } },
        });
      },
    ),
  } as unknown as BlockSink;
  // Captures the direct-CRUD task-sink calls the `task_*` host-bridge handlers make, so the task-bridge
  // tests can assert the checklist writes. The sink is injected into the ThreadDriver (its TASK_EVENT_SINK);
  // the TurnHarnessFactory no longer touches it.
  const taskEvents: Array<{
    method: 'createTask' | 'updateTask' | 'readTasks';
    scope: { kind: string; id: string };
    input?: Record<string, unknown>;
  }> = [];
  let taskSeq = 0;
  const taskSink = {
    createTask: vi.fn(
      async (
        scope: { kind: string; id: string },
        input: Record<string, unknown>,
      ) => {
        taskEvents.push({ method: 'createTask', scope, input });
        return { id: String(++taskSeq) };
      },
    ),
    updateTask: vi.fn(
      async (
        scope: { kind: string; id: string },
        input: Record<string, unknown>,
      ) => {
        taskEvents.push({ method: 'updateTask', scope, input });
        return { ok: true };
      },
    ),
    readTasks: vi.fn(async (scope: { kind: string; id: string }) => {
      taskEvents.push({ method: 'readTasks', scope });
      return [];
    }),
  } as unknown as TaskEventSink;
  const usage = {
    applyHarvest: vi.fn().mockResolvedValue(undefined),
  } as unknown as OauthUsageService;
  const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, usage);
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
  // Captures the driver's Phase-3 brain wakes (`notifyThreadHalted`) fired via the BrainGateway.
  const wakes: Array<{
    jobId: string;
    threadId: string;
    outcome: 'blocked' | 'incomplete' | 'failed';
  }> = [];
  // Records each seeded open-PR turn (`BuildShipService` → `brain.openPrAtShip`). Replaces the old proxy of
  // "an engine execute/claude call happened" now that the ship step is a brain turn, not a separate session.
  const shipSeeds: Array<{ jobId: string; branch: string }> = [];
  // The neutral BrainGateway both BuildShipService (openPrAtShip) and ThreadDriver (halt wakes) reach the
  // brain through. Records each seeded `openPrAtShip` turn + the driver's Phase-3 `notifyThreadHalted`
  // wakes (the seeded/wake turns themselves are exercised in the brain specs — here the host latches by
  // branch discovery, and the fake mirrors the brain stamping `halt_waked_at`).
  const gateSeeds: Array<{ jobId: string; threadId: string }> = [];
  const brainGateway = {
    openPrAtShip: async (input: { jobId: string; branch: string }) => {
      shipSeeds.push({ jobId: input.jobId, branch: input.branch });
    },
    seedPostBuildGate: async (input: { jobId: string; threadId: string }) => {
      gateSeeds.push({ jobId: input.jobId, threadId: input.threadId });
    },
    notifyThreadHalted: async (
      jobId: string,
      threadId: string,
      outcome: 'blocked' | 'incomplete' | 'failed',
    ) => {
      wakes.push({ jobId, threadId, outcome });
    },
  } as unknown as BrainGateway;
  // Spy for the per-thread service teardown (`atlas-svc stop-all` via the sandbox provider). The driver
  // fires it on a clean thread `done`, never on a blocked/halt outcome.
  const stopAllServices = vi.fn().mockResolvedValue({ ok: true });
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
      stopAllServices,
      sandboxContainerName: () => 'atlas-sbx-thread-test',
      bridgeCaddyToSandbox: async () => undefined,
      unbridgeCaddyFromSandbox: async () => undefined,
      listLiveThreadJobIds: async () => [],
    },
    // CredentialResolver: env-fallback shape (no tenant rows) — api_key auth, no token.
    {
      anthropicKey: opts.anthropicKey ?? (async () => undefined),
      openaiKey: async () => undefined,
      githubToken: async () => undefined,
      githubWriteIdentity: async () => ({}),
      engineAuth: async () => ({ secret: 'test-secret' }),
    } as unknown as CredentialResolver,
    // OauthUsageService: the session-limit park reads getResetAt; default → no harvested window. A
    // TEXT-fallback session-limit hit's corroboration check reads getUtilization — defaults to undefined
    // (uncorroborated); opts.usageUtilization lets a test drive it deterministically.
    {
      getResetAt: () => undefined,
      getUtilization: vi.fn(async () => opts.usageUtilization),
      applyHarvest: vi.fn().mockResolvedValue(undefined),
    } as unknown as OauthUsageService,
    // McpResolver: no user-defined MCP servers in tests.
    {
      resolveForTurn: async () => [],
      resolveForSandbox: async () => [],
    } as never,
    // McpOAuthService: no OAuth servers in tests (and the fake SANDBOX_PROVIDER has no kickMcpHubRefresh anyway).
    { refreshForSandbox: async () => ({ rotated: false }) } as never,
    // SkillResolver: no skills in tests unless a test provides them (drives the nudge-selection path).
    (opts.skillResolver ?? {
      resolveForTurn: async () => [],
      resolveReviewSkillsForThread: async () => [],
    }) as never,
    // SKILL_NUDGE_SELECTOR: picks no skills by default; opts.skillNudgeSelector lets a test return real ones.
    (opts.skillNudgeSelector ?? {
      select: async () => [],
    }) as unknown as SkillNudgeSelector,
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
      contextDirHost: (_jobId: string, _orgId: string) =>
        opts.contextDirHost ?? '/ctx',
    } as unknown as import('./job-lifecycle.service').JobLifecycleService,
    // BuildShipService: the real terminal "ship" over the same git/pr/store fakes, so the leak-scan/latch
    // assertions hold. The open-PR step is now a SEEDED BRAIN TURN reached via the neutral BrainGateway (no
    // separate engine session), and the host latches the PR by branch discovery.
    new BuildShipService(git, pr, store, brainGateway),
    // AutoMergeService: only `mergeNow` (the manual "Merge PR" click path) is called by the driver; default
    // no-op resolve unless a test overrides it.
    (opts.autoMerge ?? {
      mergeNow: async () => false,
    }) as unknown as import('./auto-merge.service').AutoMergeService,
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
    liveTurns,
    // TurnRegistry: no in-flight rows by default (fresh runs) — reattach lookup returns empty. A reattach
    // test overrides `listRunning` to surface a matching in-flight `step` row.
    (opts.turnRegistry ?? {
      listRunning: async () => [],
    }) as unknown as import('../sandbox/turn-registry.service').TurnRegistry,
    // BrainGateway: the driver's neutral brain seam (Phase-3 halt wakes).
    brainGateway,
    taskSink,
    undefined,
    undefined,
    opts.claudeCreds as ClaudeCredentialStore | undefined,
    undefined, // configStore
    undefined, // stimulusStore
    undefined, // jit
    {
      planningThreadId: async (jobId: string) => `planning-${jobId}`,
    } as never,
  );
  // SHIP-REVIEW GATE auto-approve: unless a test opts out, simulate the operator clicking "Ship it" the
  // instant the gate parks — so the build→ship pipeline tests keep reaching `done`. The re-drive fast-
  // forwards the already-`done` threads (no re-execute/re-materialize) and ships.
  if (opts.autoShipApprove !== false) {
    (store.parkForShipReview as ReturnType<typeof vi.fn>).mockImplementation(
      async (jobId: string) => {
        if (state.job.status !== 'building') return false;
        state.job.status = 'ready';
        // Fire the "Ship it" on a MACROtask to preserve the historical operator-after-park shape for most
        // tests. A dedicated regression below covers the tighter click-while-parking race.
        setTimeout(() => {
          void driver.resolveShipApprovalDurably(jobId, 'auto-test');
        }, 0);
        return true;
      },
    );
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
    wakes,
    stopAllServices,
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
    await flushUntil(() => state.job.status === 'pr_open');

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
    expect(h.shipSeeds).toEqual([
      { jobId: state.job.id, branch: 'atlas/feature-job-abcd' },
    ]);

    // Both builder threads are done with a handoff; singleton split-pipeline rows may be appended for shipping.
    expect(
      state.threads
        .filter((s) => s.kind === 'builder')
        .every((s) => s.status === 'done'),
    ).toBe(true);
    expect(state.threads[1].handoffIn).toContain('Backend');

    // Each completed thread frees its test services deterministically (`atlas-svc stop-all` via the sandbox
    // provider) — once per thread, keyed by jobId — so a thread's stack doesn't sit resident all build long.
    expect(h.stopAllServices).toHaveBeenCalledTimes(2);
    expect(h.stopAllServices).toHaveBeenCalledWith(state.job.id);

    // ONE branch — threads stacked on the same feature branch (the host never pushes; Atlas pushes
    // in-sandbox as part of the ship turn, which ran).
    expect(state.job.featureBranch).toBe('atlas/feature-job-abcd');
    expect(h.shipSeeds.length).toBeGreaterThanOrEqual(1);
    expect(state.job.status).toBe('pr_open');
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
      new Error(
        'Command failed: git status\nfatal: cannot chdir to packages/jwt-auth',
      ),
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // A notice went onto a LENS lane ({ lensId }) carrying the folded-in error reason (shortReason).
    const lensNotices = h.autofix.emitReviewNotice.mock.calls.filter(
      (c) =>
        (c[1] as { lensId?: string }).lensId &&
        String(c[2]).includes('failed to run'),
    );
    expect(lensNotices.length).toBeGreaterThan(0);
    expect(String(lensNotices[0][2])).toContain(
      'fatal: cannot chdir to packages/jwt-auth',
    );

    // Every review_agent child carries the `failed` CONDITION (step stays where it was), and the failure
    // never sank the job.
    const lensKids = (state.reviewChildren ?? []).filter(
      (c) => c.kind === 'review_agent',
    );
    expect(lensKids.length).toBeGreaterThan(0);
    expect(lensKids.every((c) => c.condition === 'failed')).toBe(true);
    expect(state.job.status).toBe('pr_open');
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
    await flushUntil(() => state.job.status === 'pr_open');

    const fixNotices = h.autofix.emitReviewNotice.mock.calls.filter(
      (c) =>
        (c[1] as { fix?: boolean }).fix === true &&
        String(c[2]).includes('nothing to fix'),
    );
    expect(fixNotices.length).toBeGreaterThan(0);
    const postKids = (state.reviewChildren ?? []).filter(
      (c) => c.kind === 'review_fix',
    );
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
    state.reviewChildren = [
      {
        id: `${staleId}-review-existing`,
        parentId: staleId,
        kind: 'review_agent',
        brief: 'Existing review',
        ordinal: 10,
        config: { lensId: 'correctness' },
        status: 'done',
        condition: 'none',
        reviewFindings: [],
      },
    ];
    (h.store.getThread as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        const s = state.threads.find((x) => x.id === id);
        if (!s) return null;
        if (id === staleId) {
          s.status = 'done';
          s.handoffOut = 'HO-from-other-drive';
        }
        return { ...s };
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // Only the FIRST thread executed + reviewed; the already-done 2nd thread was fast-forwarded.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(1);
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(1);
    // It never materialized review children for the finished thread (no re-review).
    const materialized = (
      h.store.materializeReviewChildren as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(materialized.some((c) => c[0].id === staleId)).toBe(false);
    // The build still completes to a PR.
    expect(state.job.status).toBe('pr_open');
  });

  it('resumes an auto_fixing builder as finished — no re-execute, review resumes, and handoff advances', async () => {
    // A restart can catch a builder after it completed and while its review children are running:
    // `runReviewChildren` has flipped the builder to `auto_fixing`, but the builder's own work and
    // handoff are already durable. The build loop must resume review/advance, not re-run that builder.
    const backend = thread('sec-be', 10, 'Backend', 'idle');
    backend.handoffOut = 'Backend handoff from completed builder';
    backend.startSha = 'sha-before-backend';
    const frontend = thread('sec-fe', 20, 'Frontend');
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [backend, frontend],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    const executeStepIds = h.calls
      .filter((c) => c.mode === 'execute')
      .map((c) => c.stepId);
    expect(executeStepIds).not.toContain('sec-be-ph0');
    expect(executeStepIds).toContain('sec-fe-ph0');
    expect(h.store.setThreadStatus).not.toHaveBeenCalledWith(
      'sec-be',
      'executing',
    );
    expect(h.store.materializeReviewChildren).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sec-be' }),
      expect.any(Array),
    );
    expect(frontend.handoffIn).toBe('Backend handoff from completed builder');
    expect(backend.status).toBe('done');
  });

  it('runs the master-review thread as a CODEX execute turn (xhigh) and SKIPS per-thread auto-fix for it', async () => {
    // Capture per-turn engine + reasoning effort so we can assert the master-review branch flipped them.
    const runs: Array<{
      mode: string;
      engine: string;
      effort?: string;
      stepId?: string | null;
    }> = [];
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
    const review = thread(
      'sec-review',
      30,
      'Master review — whole-diff review & fix',
      'idle',
      true,
    );
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
    await flushUntil(() => state.job.status === 'pr_open');

    // The feature thread runs Claude; the master-review thread runs Codex at xhigh.
    const execs = runs.filter((r) => r.mode === 'execute');
    expect(execs).toHaveLength(2);
    expect(execs[0].engine).toBe('claude');
    expect(execs[1].engine).toBe('codex');
    expect(execs[1].effort).toBe('xhigh');

    // The post-build review ran for the feature thread ONLY — the master-review thread IS the review (its
    // spec declares no children), so it materializes none.
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(1);
    expect(
      state.threads
        .filter((s) => s.kind === 'builder' || s.kind === 'master_review')
        .every((s) => s.status === 'done'),
    ).toBe(true);
  });

  it('a claude builder turn — AND its follow-up COMMIT-NUDGE turn (kind:\'step\') — both forward modelReasoningEffort: "high"', async () => {
    // The registry pins the `builder` thread-kind to 'high' reasoning effort; both the primary execute
    // turn and the commit-nudge follow-up turn (which reuses the batch reattach path, `kind:'step'`) read
    // it off the same spec, so both must forward the SAME value to the engine.
    const runs: Array<{
      engine: string;
      effort?: string;
      turnKind?: string;
      isCommitNudge?: boolean;
    }> = [];
    const { turn: baseTurn } = makeTurn({});
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          engine: string;
          modelReasoningEffort?: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
          turnMeta?: { kind?: string; ctx?: { commitNudge?: unknown } };
        }) => {
          runs.push({
            engine: input.engine,
            effort: input.modelReasoningEffort,
            turnKind: input.turnMeta?.kind,
            isCommitNudge: input.turnMeta?.ctx?.commitNudge != null,
          });
          return (
            baseTurn.runTurn as unknown as (i: typeof input) => Promise<unknown>
          )(input);
        },
      ),
      canReattach: () => false,
    } as unknown as TurnRunnerService;

    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { turn });
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);
    // The writer "forgot" to commit on its first pass (tree dirty) — the host nudges it once (a kind:'step'
    // resumed turn), and the nudge itself leaves the tree clean.
    let hasChangesCalls = 0;
    (h.git as unknown as { hasChanges: ReturnType<typeof vi.fn> }).hasChanges =
      vi.fn(async () => {
        hasChangesCalls += 1;
        return hasChangesCalls === 1;
      });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    const builderRuns = runs.filter((r) => !r.isCommitNudge);
    const nudgeRuns = runs.filter((r) => r.isCommitNudge);
    expect(builderRuns.length).toBeGreaterThan(0);
    expect(nudgeRuns.length).toBeGreaterThan(0);
    expect(
      builderRuns.every((r) => r.engine === 'claude' && r.effort === 'high'),
    ).toBe(true);
    expect(
      nudgeRuns.every(
        (r) =>
          r.engine === 'claude' && r.effort === 'high' && r.turnKind === 'step',
      ),
    ).toBe(true);
  });

  it('restart recovery reattaches an in-flight commit nudge instead of kicking a duplicate one', async () => {
    let dirty = true;
    const runTurn = vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        toolBridge?: ToolBridgeOptions;
      }) => {
        await assertThreadDone(input);
        return {
          report: 'built',
          session: {
            id: 'sess-build',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: input.mode as 'plan' | 'execute' | 'review',
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      },
    );
    const reattach = vi.fn(
      async (input: Parameters<TurnRunnerService['reattach']>[0]) => {
        dirty = false;
        return {
          report: 'commit nudge finished',
          session: {
            id: 'sess-build',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: 'execute' as const,
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      },
    );
    const turn = {
      runTurn,
      reattach,
      canReattach: () => true,
    } as unknown as TurnRunnerService;
    const listRunning = vi.fn(async () =>
      dirty
        ? [
            {
              turn_id: 'commit-turn-live',
              job_id: 'job-abcdef12',
              org_id: 'T1',
              channel: 'C1',
              lane: 'thread:sec-be',
              kind: 'step',
              container_id: 'ctr-commit',
              status: 'running',
              ctx: {
                repoId: 'proj',
                threadId: 'sec-be',
                anchorStepId: 'sec-be-ph0',
                commitNudge: 1,
              },
            },
          ]
        : [],
    );

    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { turn, turnRegistry: { listRunning } as never });
    (h.git as unknown as { hasChanges: ReturnType<typeof vi.fn> }).hasChanges =
      vi.fn(async () => dirty);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach.mock.calls[0][0]).toMatchObject({
      turnId: 'commit-turn-live',
      containerId: 'ctr-commit',
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it('build turns ride the shared transcript spine: richStream on, blocks tagged meta.phaseId, a build_anchor per thread batch', async () => {
    const seen: Array<{ mode: string; richStream?: boolean }> = [];
    let liveRef: LiveTurnStore | undefined;
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          jobId: string;
          stepId?: string | null;
          richStream?: boolean;
          toolBridge?: ToolBridgeOptions;
          liveRoute?: { channel: string; jobId: string; lane?: string };
          onEvent?: (e: { kind: string; [k: string]: unknown }) => void;
        }) => {
          seen.push({ mode: input.mode, richStream: input.richStream });
          const events: Array<{ kind: string; [k: string]: unknown }> = [
            { kind: 'thinking', text: 'planning the edit' },
            { kind: 'text', text: 'editing the file' },
            { kind: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
            { kind: 'tool_result', id: 't1', result: 'ok' },
          ];
          for (const e of events) {
            input.onEvent?.(e);
            // Stand in for RedisEngineRunner.consumeRealtime: the realtime consumer group mirrors each
            // engine event into the LiveTurnStore off `liveRoute` — the harness's onEvent no longer does.
            if (input.liveRoute) {
              liveRef?.push(
                input.liveRoute.channel,
                input.liveRoute.jobId,
                e,
                input.liveRoute.lane,
              );
            }
          }
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
    liveRef = h.liveTurns;
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

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
        (c) => typeof c[3] === 'string' && c[3].startsWith('thread:'),
      ),
    ).toBe(true);

    // The old `build_event` relay is gone — no build_event posts to the surface.
    expect(h.posts.every((p) => !p.includes('[tool]'))).toBe(true);
  });

  it('splices the Haiku-selected skill nudge into the build turn and persists the group selection', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const select = vi.fn(async () => [
      { name: 'nestjs-best-practices', reason: 'backend NestJS work' },
    ]);
    const h = assemble(state, {
      skillResolver: {
        resolveForTurn: async () =>
          [
            { name: 'nestjs-best-practices', description: 'NestJS conventions' },
          ] as never,
        resolveReviewSkillsForThread: async () => [],
      },
      skillNudgeSelector: { select } as unknown as SkillNudgeSelector,
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    const prompts = h.sunk
      .filter((s) => s.block.kind === 'build_anchor')
      .map((a) => String(a.block.meta?.prompt));
    expect(
      prompts.some(
        (p) =>
          p.includes('<available_skills>') &&
          p.includes('`nestjs-best-practices`') &&
          p.includes('load it with the `Skill` tool'),
      ),
    ).toBe(true);
    // The selection was persisted on the build thread GROUP (the rotation-stable grain).
    expect(h.store.persistGroupSkillNudge).toHaveBeenCalledWith(
      'thread-group-sec-be',
      expect.objectContaining({
        skills: [{ name: 'nestjs-best-practices', reason: 'backend NestJS work' }],
      }),
    );
  });

  it('renders no nudge block when the selector picks nothing — byte-identical to the no-nudge task', async () => {
    // Baseline: no build-surface skills at all → selector never even consulted → no block.
    const baseline: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const hBase = assemble(baseline);
    await hBase.driver.dispatch(baseline.job);
    await flushUntil(() => baseline.job.status === 'pr_open');
    const basePrompt = String(
      hBase.sunk.find(
        (s) =>
          s.block.kind === 'build_anchor' &&
          s.block.meta?.phaseId === 'sec-be-ph0',
      )?.block.meta?.prompt,
    );

    // Skills DO resolve, but the Haiku selector returns nothing → still no block, byte-identical output.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const select = vi.fn(async () => []);
    const h = assemble(state, {
      skillResolver: {
        resolveForTurn: async () =>
          [
            { name: 'nestjs-best-practices', description: 'NestJS conventions' },
          ] as never,
        resolveReviewSkillsForThread: async () => [],
      },
      skillNudgeSelector: { select } as unknown as SkillNudgeSelector,
    });
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');
    const prompt = String(
      h.sunk.find(
        (s) =>
          s.block.kind === 'build_anchor' &&
          s.block.meta?.phaseId === 'sec-be-ph0',
      )?.block.meta?.prompt,
    );

    expect(select).toHaveBeenCalled();
    expect(prompt).not.toContain('<available_skills>');
    expect(prompt).toBe(basePrompt);
  });

  it('reuses a prior group selection on a later leg without re-calling the selector', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
      // Simulate a group already decided by an earlier leg — a present key = "decided", even when empty.
      threadGroupConfigs: {
        'thread-group-sec-be': {
          skillNudge: {
            skills: [{ name: 'nestjs-best-practices', reason: 'prior leg' }],
            at: new Date().toISOString(),
          },
        },
        'thread-group-sec-fe': {
          skillNudge: { skills: [], at: new Date().toISOString() },
        },
      },
    };
    const select = vi.fn(async () => [
      { name: 'must-not-be-used', reason: 'x' },
    ]);
    const h = assemble(state, {
      skillResolver: {
        resolveForTurn: async () =>
          [
            { name: 'nestjs-best-practices', description: 'NestJS conventions' },
          ] as never,
        resolveReviewSkillsForThread: async () => [],
      },
      skillNudgeSelector: { select } as unknown as SkillNudgeSelector,
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // A decided group short-circuits before Haiku — the selector is never consulted again…
    expect(select).not.toHaveBeenCalled();
    // …and never re-persisted (the prior stands).
    expect(h.store.persistGroupSkillNudge).not.toHaveBeenCalled();
    // …yet the persisted pick still renders into the build turn.
    const prompts = h.sunk
      .filter((s) => s.block.kind === 'build_anchor')
      .map((a) => String(a.block.meta?.prompt));
    expect(
      prompts.some(
        (p) =>
          p.includes('<available_skills>') &&
          p.includes('`nestjs-best-practices`'),
      ),
    ).toBe(true);
  });

  it('ignores malformed persisted group selection and re-decides the nudge fail-soft', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
      threadGroupConfigs: {
        'thread-group-sec-be': {
          skillNudge: { skills: 'not-an-array', at: new Date().toISOString() },
        },
      },
    };
    const select = vi.fn(async () => [
      { name: 'nestjs-best-practices', reason: 'backend NestJS work' },
    ]);
    const h = assemble(state, {
      skillResolver: {
        resolveForTurn: async () =>
          [
            { name: 'nestjs-best-practices', description: 'NestJS conventions' },
          ] as never,
        resolveReviewSkillsForThread: async () => [],
      },
      skillNudgeSelector: { select } as unknown as SkillNudgeSelector,
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(select).toHaveBeenCalledTimes(1);
    expect(h.store.persistGroupSkillNudge).toHaveBeenCalledWith(
      'thread-group-sec-be',
      expect.objectContaining({
        skills: [{ name: 'nestjs-best-practices', reason: 'backend NestJS work' }],
      }),
    );
    const prompt = String(
      h.sunk.find((s) => s.block.kind === 'build_anchor')?.block.meta?.prompt,
    );
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('`nestjs-best-practices`');
    expect(prompt).not.toContain('backend NestJS work');
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
        status: 'building',
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
    const reattach = vi.fn(
      async (_input: Parameters<TurnRunnerService['reattach']>[0]) => {
        // The re-supplied bridge serves the in-flight `complete_thread` the pre-restart turn was mid-way through.
        await _input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'resumed and finished',
        });
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
      },
    );
    const runTurn = vi.fn();
    const turn = {
      runTurn,
      reattach,
      canReattach: () => true,
    } as unknown as TurnRunnerService;
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
    await flushUntil(() => state.job.status === 'pr_open');

    // Re-attached the live turn (with the ORIGINAL turn id + container) — never re-ran the execute batch.
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach.mock.calls[0][0]).toMatchObject({
      turnId: 'turn-live',
      containerId: 'ctr-1',
      stepId: 'sec-be-ph0',
    });
    expect(runTurn).not.toHaveBeenCalled();
    // A resume never re-emits the batch's START markers (no duplicate build_anchor).
    expect(h.sunk.filter((s) => s.block.kind === 'build_anchor')).toHaveLength(
      0,
    );
    // The resumed turn's transcript persisted + the batch committed → the run finishes; the ship turn ran
    // (Atlas opens the PR in-sandbox, the host never does).
    expect(h.shipSeeds.length).toBeGreaterThanOrEqual(1);
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
    await flushUntil(() => state.job.status === 'pr_open');

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
    await flushUntil(() => state.job.status === 'pr_open');

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
    await flushUntil(() => state.job.status === 'pr_open');

    // The done Backend thread was NOT re-executed (no exec turn for it). Only the Frontend thread ran
    // (1 execute turn, no plan turn — there is no more build-time planning).
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(0);
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(1);
    // The ship turn ran (Atlas opens the PR in-sandbox, the host never does).
    expect(h.shipSeeds.length).toBeGreaterThanOrEqual(1);
    expect(state.job.status).toBe('pr_open');
  });

  it('orchestrate resume: a batch whose anchor already has a commit_sha FAST-FORWARDS (no re-run) (issue #6)', async () => {
    // Crash AFTER the batch committed (commit_sha stamped on the anchor) but BEFORE the step row flipped
    // to done. Resume must NOT re-run the orchestrator against the already-committed tree.
    const state: StoreState = {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'idle')],
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
    await flushUntil(() => state.job.status === 'pr_open');

    // The committed batch fast-forwarded: NO execute turn, NO new commit, the step marked done.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(h.commits.filter((m) => m.startsWith('Backend —'))).toHaveLength(0);
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
    expect(state.job.status).toBe('pr_open');
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
    await flushUntil(() => state.job.status === 'pr_open');

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
    expect(state.threads[0].status).toBe('idle'); // halted, NOT silently done
    expect(state.threads[0].condition).toBe('incomplete');
    expect(state.job.halt?.kind).toBe('incomplete'); // needs-you, recoverable — NOT done, NOT failed
    expect(h.opened).toHaveLength(0); // nothing shipped
    expect(
      h.posts.some((p) => p.includes('without asserting completion')),
    ).toBe(true); // a durable halt card, never a silent dead-end
    expect(h.store.materializeReviewChildren).not.toHaveBeenCalled(); // review skipped on a halt
    expect(h.stopAllServices).not.toHaveBeenCalled(); // no service teardown on a halt (only on clean done)
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
      const h = assemble(state, {
        turn,
        contextDirHost: ctxDir,
        worktreePath: worktreeDir,
      });

      await h.driver.dispatch(state.job);
      // The trail is rendered under `<contextDirHost>/generated/threads/<ordinal>-<slug>/` — here `010-backend`.
      const trail = join(
        ctxDir,
        'generated',
        'threads',
        '010-backend',
        'completion.md',
      );
      // Wait for CONTENT, not just the file's existence: writeCompletionMd is fire-and-forget and
      // writeFile creates the (empty) file before the content lands, so an existence-only wait can read
      // '' and flake (observed in CI). Waiting for non-empty content makes the assertions deterministic.
      await flushUntil(
        () => existsSync(trail) && readFileSync(trail, 'utf8').length > 0,
      );

      expect(existsSync(trail)).toBe(true);
      expect(readFileSync(trail, 'utf8')).toContain('# Thread not done: Backend');

      // Regression guard (the whole point): nothing is written into the git worktree.
      expect(existsSync(join(worktreeDir, '.atlas'))).toBe(false);
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it('creates the host evidence/<threadDirName>/ subfolder when dispatching a thread leg', async () => {
    const ctxDir = mkdtempSync(join(tmpdir(), 'atlas-evi-'));
    try {
      const state: StoreState = {
        job: makeJob(),
        record: makeRecord(),
        threads: [thread('sec-be', 10, 'Backend')],
        steps: [],
        route: { channel: 'C1', threadTs: 't1' },
        operatorInputCards: [],
      };
      const h = assemble(state, { contextDirHost: ctxDir });

      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.status === 'pr_open');

      // `evidenceDirForThread` lazily mkdirs `<contextDirHost>/evidence/<ordinal>-<slug>` on the execute
      // turn — here `010-backend` (ordinal 10, brief "Backend").
      expect(existsSync(join(ctxDir, 'evidence', '010-backend'))).toBe(true);
    } finally {
      rmSync(ctxDir, { recursive: true, force: true });
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
    const h = assemble(state, { turn });

    await withInstantHostRetryBackoff(async () => {
      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.status === 'pr_open');
    });

    expect(state.job.status).toBe('pr_open'); // recovered
    expect(
      calls.filter((c) => c.mode === 'execute').length,
    ).toBeGreaterThanOrEqual(2); // retried
    expect(
      (h.store.setJobStatus as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[1] === 'failed',
      ),
    ).toBe(false); // never stamped failed
    expect(h.posts.some((p) => p.includes('Build failed'))).toBe(false); // no phantom error relay
  });

  it('SILENTLY RE-DRIVES the lane on the d1 stream-closed circuit-breaker throw — restarts on a fresh turn (never failed)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // The EXACT wrapped shape the engine produces when the circuit-breaker trips: EngineCore throws
    // `engine stream closed: control channel severed mid-turn (circuit-breaker)`; the entrypoint relays it
    // (err.stack) and redis-engine-runner rewraps it as `in-sandbox engine turn failed: <msg>`. Its "stream
    // closed" substring must drive the driver's TRANSIENT_ERROR_RE → runJobWithTransientRetry (fresh turn).
    const streamClosedThrow =
      'in-sandbox engine turn failed: Error: engine stream closed: control channel severed mid-turn (circuit-breaker)';
    const { turn, calls } = makeTurn({
      transientFailures: 1,
      transientMessage: streamClosedThrow,
    });
    const h = assemble(state, { turn });

    await withInstantHostRetryBackoff(async () => {
      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.status === 'pr_open');
    });

    expect(state.job.status).toBe('pr_open'); // the lane self-healed on a fresh turn
    expect(
      calls.filter((c) => c.mode === 'execute').length,
    ).toBeGreaterThanOrEqual(2); // re-drove after the storm throw
    expect(
      (h.store.setJobStatus as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[1] === 'failed',
      ),
    ).toBe(false); // never stamped failed
    expect(h.posts.some((p) => p.includes('Build failed'))).toBe(false); // no phantom failure relay
  });

  it('an infra error retries up to MAX_HOST_RETRIES at the fixed HOST_RETRY_BACKOFF_MS, posting a durable quiet notice + fanning turn_retry each attempt', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // Fails MAX_HOST_RETRIES times (exhausting exactly the retry budget), then succeeds on the final try.
    const { turn, calls } = makeTurn({ transientFailures: MAX_HOST_RETRIES });
    const h = assemble(state, { turn });

    await withInstantHostRetryBackoff(async () => {
      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.status === 'pr_open');
    });

    expect(state.job.status).toBe('pr_open'); // recovered on the LAST retry within budget
    expect(
      calls.filter((c) => c.mode === 'execute').length,
    ).toBeGreaterThanOrEqual(MAX_HOST_RETRIES + 1);

    // Each attempt posts a durable quiet `system_notice` (never the scary "Build failed" relay).
    const retryNotices = h.sunk.filter(
      (s) =>
        (s.block.meta as { source?: string } | null)?.source ===
        'system_notice',
    );
    expect(retryNotices).toHaveLength(MAX_HOST_RETRIES);
    expect(retryNotices[0].block.text).toContain(
      `auto-retry 1/${MAX_HOST_RETRIES}`,
    );
    expect(retryNotices[MAX_HOST_RETRIES - 1].block.text).toContain(
      `auto-retry ${MAX_HOST_RETRIES}/${MAX_HOST_RETRIES}`,
    );
    expect(h.posts.some((p) => p.includes('Build failed'))).toBe(false);

    // Each attempt also fans a best-effort `turn_retry` indicator, attempts numbered 1..MAX_HOST_RETRIES.
    const retryCalls = (h.liveTurns.retry as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(retryCalls).toHaveLength(MAX_HOST_RETRIES);
    expect(
      retryCalls.map((c) => (c[3] as { attempt: number }).attempt),
    ).toEqual(Array.from({ length: MAX_HOST_RETRIES }, (_, i) => i + 1));
    expect(
      retryCalls.every(
        (c) => (c[3] as { max: number }).max === MAX_HOST_RETRIES,
      ),
    ).toBe(true);
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
    await flushUntil(
      () => (h.turn.runTurn as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    await flushUntil(() => false, 20);

    expect(state.job.status).toBe('building'); // LEFT running — boot-resume continues it
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
    expect(state.job.status).toBe('building');
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
    await flushUntil(() => state.job.status === 'pr_open');

    expect(
      h.posts.some(
        (p) => p.includes('Off-spec') && p.includes('README nobody asked for'),
      ),
    ).toBe(true);
    expect(state.job.status).toBe('pr_open'); // a deviation is surfaced, not a failure
  });

  it('a text-fallback session limit uncorroborated by the usage window quiet-retries instead of parking', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1', orgId: 'T1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { usageUtilization: 40 });
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new EngineSessionLimitError(
          "You've hit your session limit",
          undefined,
          'five_hour',
          'sess-limit',
          undefined,
          'text',
        );
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() =>
      (h.store.setSessionResume as ReturnType<typeof vi.fn>).mock.calls.some(
        (args) => (args[2] as { kind?: string })?.kind === 'retry',
      ),
    );

    expect(h.store.setSessionResume).toHaveBeenCalledWith(
      state.job.id,
      expect.any(String),
      expect.objectContaining({ lane: 'build', kind: 'retry' }),
    );
    expect(
      h.posts.filter((p) => p.includes("You've hit your session limit")),
    ).toHaveLength(0);
    expect(h.store.claimSessionLimitTextMisfire).toHaveBeenCalledTimes(1);
  });

  it('a text-fallback session limit corroborated by a near-capped usage window durably parks like a structured hit', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1', orgId: 'T1' },
      operatorInputCards: [],
    };
    const h = assemble(state, { usageUtilization: 98 });
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new EngineSessionLimitError(
          "You've hit your session limit",
          undefined,
          'five_hour',
          'sess-limit',
          undefined,
          'text',
        );
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'session_limit');

    expect(state.job.halt?.kind).toBe('session_limit');
    expect(
      h.posts.filter((p) => p.includes("You've hit your session limit")),
    ).toHaveLength(1);
    const resumeCall = (
      h.store.setSessionResume as ReturnType<typeof vi.fn>
    ).mock.calls.find((args) => args[0] === state.job.id);
    expect(
      (resumeCall?.[2] as { kind?: string } | undefined)?.kind,
    ).toBeUndefined();
  });

  it('a text-fallback session limit durably parks once the misfire budget is exhausted (backstop escalation)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1', orgId: 'T1' },
      operatorInputCards: [],
    };
    // usageUtilization left undefined (uncorroborated) — the misfire budget is what decides here.
    const h = assemble(state);
    // Preload two prior misses so this drive's third consecutive miss reaches
    // SESSION_LIMIT_TEXT_MISFIRE_MAX and parks immediately.
    await h.store.claimSessionLimitTextMisfire(state.job.id, 3);
    await h.store.claimSessionLimitTextMisfire(state.job.id, 3);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new EngineSessionLimitError(
          "You've hit your session limit",
          undefined,
          'five_hour',
          'sess-limit',
          undefined,
          'text',
        );
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'session_limit');

    expect(state.job.halt?.kind).toBe('session_limit');
    expect(
      h.posts.filter((p) => p.includes("You've hit your session limit")),
    ).toHaveLength(1);
    const resumeCall = (
      h.store.setSessionResume as ReturnType<typeof vi.fn>
    ).mock.calls.find((args) => args[0] === state.job.id);
    expect(
      (resumeCall?.[2] as { kind?: string } | undefined)?.kind,
    ).toBeUndefined();
  });

  it("request_operator_input pauses the thread and resumes on the operator's answer", async () => {
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
          const result = await input.toolBridge!.tools[
            'request_operator_input'
          ]({
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
    const originalOpen = (
      h.store.openOperatorInputCard as ReturnType<typeof vi.fn>
    ).getMockImplementation()!;
    (
      h.store.openOperatorInputCard as ReturnType<typeof vi.fn>
    ).mockImplementation(async (jobId: string, question: string) => {
      const opened = await originalOpen(jobId, question);
      const card = state.operatorInputCards.find(
        (c) => c.questionId === opened.questionId,
      );
      if (card) card.answer = 'Use Postgres.';
      return opened;
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // The tool was consulted (a card was opened) and resolved to the answer.
    expect(h.store.openOperatorInputCard).toHaveBeenCalledTimes(1);
    expect(h.store.findOpenOperatorInputCard).toHaveBeenCalled();
    expect(h.store.readOperatorInputAnswer).toHaveBeenCalled();
    expect(h.store.markOperatorInputDelivered).toHaveBeenCalledTimes(1);

    // The pause is now on the condition overlay: it went to 'paused' then back to 'none' around the pause,
    // while the STEP stays at 'executing' throughout.
    const conditionCalls = (
      h.store.setThreadCondition as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[1]);
    expect(conditionCalls).toContain('paused');
    const pausedIdx = conditionCalls.indexOf('paused');
    expect(conditionCalls.slice(pausedIdx + 1)).toContain('none');

    // The build proceeded to completion carrying the answer in its report.
    expect(state.job.status).toBe('pr_open');
  });
});

// ── Thread 3 — dynamic (type-routed) lens selection + the async-sema concurrency cap ────────────────

describe('ThreadDriver — reviewAgentsForThread selection + semaphore concurrency', () => {
  function lensIdsMaterialized(state: StoreState): (string | undefined)[] {
    return (state.reviewChildren ?? [])
      .filter((c) => c.kind === 'review_agent')
      .map((c) => (c.config as { lensId?: string }).lensId);
  }

  it('materializes the composed set (always-on + data_safety) for a `data` thread', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [
        thread(
          'sec-data',
          10,
          'Data migration',
          'idle',
          false,
          'none',
          'data',
        ),
      ],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(lensIdsMaterialized(state).sort()).toEqual(
      ['correctness', 'holistic', 'data_safety'].sort(),
    );
  });

  it('drops correctness for a `docs` thread', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [
        thread('sec-docs', 10, 'Docs pass', 'idle', false, 'none', 'docs'),
      ],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    const lensIds = lensIdsMaterialized(state);
    expect(lensIds).not.toContain('correctness');
    expect(lensIds.sort()).toEqual(['holistic'].sort());
  });

  it('with cap >= lens count, ALL lenses start concurrently — the fixed-batch-of-3 barrier is gone', async () => {
    // 'general' composes the always-on lenses (correctness + holistic); the REVIEW_LENS_CONCURRENCY constant
    // (8) comfortably covers them, so a real semaphore (vs. the old `concurrency = 3` batch loop) lets every
    // lens acquire at once.
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [
        thread('sec-be', 10, 'Backend', 'idle', false, 'none', 'general'),
      ],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    let inFlight = 0;
    let peak = 0;
    h.autofix.runReviewLens.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(peak).toBe(2);
    // Every read-only finder turn runs on Sonnet, not the default Opus worker (the token-savings change).
    expect(h.autofix.runReviewLens).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'claude-sonnet-5' }),
    );
  });
});

/** Cast a git mock's `changedFileNames` to a mock fn so a test can stub its return per baseSha. Mirrors
 *  the `as ReturnType<typeof vi.fn>` cast style already used on the store mocks above. */
function stubChangedFileNames(
  git: LocalGitService,
  impl: (worktreePath: string, baseSha: string) => Promise<string[]>,
): void {
  (
    git as unknown as { changedFileNames: ReturnType<typeof vi.fn> }
  ).changedFileNames = vi.fn(impl);
}

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
    const h = assemble(state);
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

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
    const h = assemble(state);
    stubChangedFileNames(h.git, async () => ['src/routes/health.ts']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // The persisted base is reused verbatim — the set-once persist is never re-invoked, never overwritten.
    const ensure = h.store.ensureThreadStartSha as ReturnType<typeof vi.fn>;
    expect(ensure).not.toHaveBeenCalled();
    expect(state.threads[0].startSha).toBe('base-sha');
  });
});

// ── not-done handling + operator redrive ───────────────────────────────────────────────────────────

/** Wait until a thread lands in the single "not done" state (`condition==='incomplete'`) and the drive has
 *  FULLY exited (its `finally` cleared the `active` guard) — the real precondition for an operator redrive,
 *  which would otherwise hit the `active` no-op while `drive` is still unwinding. */
async function waitForNotDoneHalt(
  h: { driver: ThreadDriver },
  state: StoreState,
): Promise<void> {
  await flushUntil(() =>
    state.threads.some((t) => t.condition === 'incomplete'),
  );
  const active = (h.driver as unknown as { active?: Set<string> }).active;
  await flushUntil(() => !active?.has(state.job.id));
}

describe('ThreadDriver — not-done handling, operator redrive, and complete_thread task-nudge', () => {
  it('an operator redrive after the halt leaves the active window can resume the thread', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    // A turn that ends WITHOUT complete_thread → the thread lands not-done (`incomplete`).
    const { turn } = makeTurn({ completeThread: false });
    const h = assemble(state, { turn });
    await h.driver.dispatch(state.job);
    await waitForNotDoneHalt(h, state);
    // A redrive issued right after the halt succeeds (job flips back to running from the incomplete halt):
    await h.driver.redriveThread(
      state.job.id,
      'sec-be',
      'grant the env and retry',
    );
    await flushUntil(
      () => (state.threads[0].orientation ?? '') === 'grant the env and retry',
    );
    expect(state.threads[0].orientation).toBe('grant the env and retry');
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
    // First turn ends WITHOUT complete_thread (not done); after the operator/brain re-drives with guidance,
    // the SAME thread completes.
    let endedIncompleteOnce = false;
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const tools = input.toolBridge?.tools;
          if (!endedIncompleteOnce) {
            endedIncompleteOnce = true;
            // end the turn without asserting completion → `incomplete`
          } else if (tools?.['complete_thread']) {
            await tools['complete_thread']({ summary: 'built after guidance' });
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
    // Wait for the not-done halt (fired once the job leaves the active window) — the real precondition for a
    // redrive. Redriving before then would hit the `active` guard.
    await waitForNotDoneHalt(h, state);
    // A not-done thread writes NO terminal record (`complete_thread` is the sole done-report).
    expect(
      (state.threads[0] as { terminal_record?: ThreadTerminalRecord | null })
        .terminal_record ?? null,
    ).toBeNull();
    expect(state.threads[0].condition).toBe('incomplete');

    // The operator/brain re-drives with guidance.
    await h.driver.redriveThread(
      state.job.id,
      'sec-be',
      'the key is granted now — retry the build',
    );
    await flushUntil(() => state.job.status === 'pr_open');

    expect(state.threads[0].orientation).toBe(
      'the key is granted now — retry the build',
    ); // guidance populated the dead orientation hook
    expect(state.job.status).toBe('pr_open'); // shipped after the fix
  });

  it('redriveThread clears a stale condition before the asynchronous drive observes the row', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'idle', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    vi.spyOn(
      h.driver as unknown as { drive: (jobId: string) => Promise<void> },
      'drive',
    ).mockResolvedValue(undefined);

    const result = await h.driver.redriveThread(
      state.job.id,
      'sec-be',
      'retry now',
    );

    expect(result.ok).toBe(true);
    expect(state.threads[0].status).toBe('idle');
    expect(state.threads[0].condition).toBe('none');
    expect(h.store.setThreadCondition).toHaveBeenCalledWith('sec-be', 'none');
  });

  it('does NOT block complete_thread on an open checklist — the FIRST assertion latches done and the host drops the leftovers (advisory-only, decision d1)', async () => {
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
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const ct = input.toolBridge?.tools?.['complete_thread'];
          if (ct) {
            // A SINGLE assertion with the checklist STILL open — the regression: this used to bounce (and,
            // because the one-shot was per-turn, re-bounce on every re-delivery → permanent `incomplete`).
            // It must now latch on the first call and never wedge.
            returns.push(
              (await ct({ summary: 'built the backend' })) as Record<
                string,
                unknown
              >,
            );
          }
          return {
            report: 'built',
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
    stubChangedFileNames(h.git, async () => ['README.md']); // non-runtime → the done-gates short-circuit

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // Latched on the FIRST call (not bounced); the open items came back only as an advisory NOTE.
    expect(String(returns[0]?.['warning'] ?? '')).toContain('open item');
    const term = (
      state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }
    ).terminal_record;
    expect(term?.status).toBe('done');
    expect(state.job.status).toBe('pr_open');
    // The host force-closes the unreconciled leftovers to `dropped` on the done transition.
    expect(h.store.dropOpenThreadTasks).toHaveBeenCalledWith('sec-be');
    const tasks = (state.threads[0] as { tasks?: TaskItem[] }).tasks ?? [];
    expect(tasks.map((t) => t.status)).toEqual(['dropped', 'dropped']);
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
        async (input: {
          mode: string;
          stepId?: string | null;
          jobId: string;
          toolBridge?: ToolBridgeOptions;
        }) => {
          const ct = input.toolBridge?.tools?.['complete_thread'];
          if (ct) {
            // Both calls assert done with the checklist STILL open: the first latches (advisory note, never
            // a block); the second is idempotent (`afterTerminal`). Neither is bounced.
            returns.push(
              (await ct({ summary: 'built the backend' })) as Record<
                string,
                unknown
              >,
            );
            returns.push(
              (await ct({ summary: 'built the backend' })) as Record<
                string,
                unknown
              >,
            );
          }
          return {
            report: 'built',
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
    stubChangedFileNames(h.git, async () => ['README.md']);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(String(returns[0]?.['warning'] ?? '')).toContain('open item');
    expect(returns[1]?.['warning']).toBeUndefined();
    const term = (
      state.threads[0] as { terminal_record?: ThreadTerminalRecord | null }
    ).terminal_record;
    expect(term?.status).toBe('done');
    expect(h.store.dropOpenThreadTasks).toHaveBeenCalledWith('sec-be');
    // Both stragglers flipped to `dropped` — the host never claims they were completed.
    const tasks = (state.threads[0] as { tasks?: TaskItem[] }).tasks ?? [];
    expect(tasks.map((t) => t.status)).toEqual(['dropped', 'dropped']);
    expect(state.job.status).toBe('pr_open');
  });

  it('redriveThread REFUSES a threadId belonging to another job (Codex High-1) — no budget, no mutation, no drive', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend', 'idle', false, 'paused')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    (state.threads[0] as unknown as HaltFields).halt_fix_attempts = 0;
    const h = assemble(state);
    // Call with a jobId that is NOT the thread's owner (a hallucinated / cross-job threadId).
    const r = await h.driver.redriveThread(
      'some-other-job',
      'sec-be',
      'guidance',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not part of this job/i);
    // The thread was NOT mutated (orientation untouched) and NO budget was spent:
    expect(state.threads[0].orientation).toBeNull();
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(
      0,
    );
  });

  it("redriveThread REFUSES an already-done thread — no budget, no mutation, no drive (won't resurrect a completed thread)", async () => {
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
    const r = await h.driver.redriveThread(state.job.id, 'sec-be', 'stale retry');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already complete/i);
    // Untouched: status still done, no terminal-record clear, no `executing` flip, no budget spent, no drive.
    expect(state.threads[0].status).toBe('done');
    expect((state.threads[0] as unknown as HaltFields).halt_fix_attempts).toBe(
      0,
    );
    expect(state.threads[0].orientation).toBeNull();
    expect(h.store.clearTerminalRecord).not.toHaveBeenCalled();
  });

  it('renderCompletionMd renders the Transcript line from the resolved anchor (even with a null record)', () => {
    const t = thread('sec-be', 10, 'Backend');
    const md = renderCompletionMd(t, null, '2026-07-04T00:00:00.000Z', {
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

/** Run `fn` with ONLY the fixed `HOST_RETRY_BACKOFF_MS` host-retry backoff collapsed to 0ms, on REAL timers.
 *  A host retry loop of 10×10s would otherwise burn ~100s of wall-clock; clamping just that one delay lets the
 *  loop settle instantly via the real event loop (deterministic under parallel-worker load — no fake-timer
 *  drain race). Every OTHER timer keeps its true duration, so the phase deadline's HARD wall-clock bound is
 *  untouched and never fires during the fast test. */
async function withInstantHostRetryBackoff(
  fn: () => Promise<void>,
): Promise<void> {
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      cb: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        cb,
        delay === HOST_RETRY_BACKOFF_MS ? 0 : delay,
        ...args,
      )) as unknown as typeof setTimeout);
  try {
    await fn();
  } finally {
    spy.mockRestore();
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
  function baseState(
    job = makeJob({ shipReviewApprovedAt: null }),
  ): StoreState {
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
    await flushUntil(() => state.job.status === 'ready');

    expect(state.job.status).toBe('ready');
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
    await flushUntil(() => state.job.status === 'ready');

    const acted = await h.driver.resolveShipApprovalDurably(
      state.job.id,
      'dennis',
    );
    expect(acted).toBe(true);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(state.job.shipReviewApprovedAt).toBeInstanceOf(Date);
    expect(h.shipSeeds).toEqual([
      { jobId: state.job.id, branch: 'atlas/feature-job-abcd' },
    ]);
    // The re-drive fast-forwarded the already-done threads — it did NOT re-execute or re-review them.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(2);
    expect(h.store.materializeReviewChildren).toHaveBeenCalledTimes(2);
  });

  it('ships when the ship approval races the active drive that is parking the gate', async () => {
    const state = baseState();
    const h = assemble(state, { autoShipApprove: false });

    (h.store.parkForShipReview as ReturnType<typeof vi.fn>).mockImplementation(
      async (jobId: string) => {
        if (state.job.status !== 'building') return false;
        state.job.status = 'ready';
        await h.driver.resolveShipApprovalDurably(jobId, 'dennis');
        return true;
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(state.job.shipReviewApprovedAt).toBeInstanceOf(Date);
    expect(h.shipSeeds).toEqual([
      { jobId: state.job.id, branch: 'atlas/feature-job-abcd' },
    ]);
  });

  it('a second (stale/double) ship approval is a no-op once the job has shipped', async () => {
    const state = baseState();
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'ready');
    await h.driver.resolveShipApprovalDurably(state.job.id, 'dennis');
    await flushUntil(() => state.job.status === 'pr_open');

    const again = await h.driver.resolveShipApprovalDurably(
      state.job.id,
      'dennis',
    );
    expect(again).toBe(false);
  });

  it('does NOT gate an event-kind build — it ships straight through', async () => {
    const state = baseState(
      makeJob({ kind: 'event', shipReviewApprovedAt: null }),
    );
    const h = assemble(state, { autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

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
      status: 'idle',
      condition: 'none',
      kind: 'main',
      threadGroupId: 'thread-group-main-1',
      type: 'general',
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
    expect(state.job.status).toBe('building');
    expect(state.job.prUrl).toBeNull();
  });
});

// ── ship-review gate: per-job auto-approve immediately resolves the just-parked gate ────────────────

describe('ThreadDriver — ship-review gate auto-approve (per-job opt-in)', () => {
  function baseState(job: Job): StoreState {
    return {
      job,
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }

  it.each(['ship', 'both'] as const)(
    'auto-resolves the ship gate INLINE with the job-stamped approver and ships in the same drive (mode: %s)',
    async (mode) => {
      const job = makeJob({
        shipReviewApprovedAt: null,
        autoApproveMode: mode,
        autoApproveBy: 'user-42',
      });
      const state = baseState(job);
      const h = assemble(state, { autoShipApprove: false });
      const approverSpy = vi.spyOn(
        h.driver as unknown as {
          resolveAutoApprover: (j: Job) => Promise<string>;
        },
        'resolveAutoApprover',
      );

      await h.driver.dispatch(state.job);
      // The gate auto-resolves and the SAME drive falls through to ship — no re-drive, no manual click.
      await flushUntil(() => state.job.status === 'pr_open');

      expect(h.store.parkForShipReview).toHaveBeenCalled(); // card posted for audit
      expect(h.store.approveShip).toHaveBeenCalledWith(job.id); // marker stamped inline
      expect(state.job.shipReviewApprovedAt).toBeInstanceOf(Date);
      expect(h.shipSeeds).toHaveLength(1); // PR actually opened in this drive
      await expect(approverSpy.mock.results[0].value).resolves.toBe('user-42');
    },
  );

  it('falls back to the org owner when autoApproveBy is null', async () => {
    const job = makeJob({
      shipReviewApprovedAt: null,
      autoApproveMode: 'ship',
      autoApproveBy: null,
    });
    const state = baseState(job);
    const h = assemble(state, { autoShipApprove: false });
    const ownerSpy = vi.fn(async (_orgId: string) => 'owner-99');
    (
      h.store as unknown as { ownerUserId: ReturnType<typeof vi.fn> }
    ).ownerUserId = ownerSpy;
    const approverSpy = vi.spyOn(
      h.driver as unknown as {
        resolveAutoApprover: (j: Job) => Promise<string>;
      },
      'resolveAutoApprover',
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    expect(ownerSpy).toHaveBeenCalled();
    expect(h.shipSeeds).toHaveLength(1);
    await expect(approverSpy.mock.results[0].value).resolves.toBe('owner-99');
  });

  it.each(['plan', 'off'] as const)(
    'does NOT auto-resolve the ship gate when autoApproveMode does not approve the ship gate (mode: %s)',
    async (mode) => {
      const job = makeJob({
        shipReviewApprovedAt: null,
        autoApproveMode: mode,
        autoApproveBy: null,
      });
      const state = baseState(job);
      const h = assemble(state, { autoShipApprove: false });

      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.status === 'ready');
      await flush();

      expect(h.store.approveShip).not.toHaveBeenCalled();
      expect(h.shipSeeds).toHaveLength(0);
      expect(state.job.status).toBe('ready');
    },
  );
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
            // Deterministic-fatal (not transient), so it surfaces immediately instead of auto-retrying.
            throw new EngineAuthError(
              '401 Invalid API key',
              'sess-401',
              undefined,
              true,
            );
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
    await flushUntil(() => state.job.status === 'pr_open');

    expect(state.job.status).toBe('pr_open');
    expect(h.shipSeeds.length).toBeGreaterThanOrEqual(1);
  });

  it('a transient EngineAuthError auto-retries via classifyAndSurfaceAuthHalt (NOT the generic transient loop), then marks needs_reauth once the budget is spent', async () => {
    const state = freshState();
    // ALWAYS transient-auth-fails — exhausts the MAX_HOST_RETRIES auto-retry budget.
    const turn = {
      runTurn: vi.fn(async () => {
        throw new EngineAuthError('401 Invalid API key', 'sess-401');
      }),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const getSelectedRefreshMeta = vi.fn(async () => ({
      id: 'claude-cred',
      lastRefreshedAt: new Date(),
    }));
    const markNeedsReauth = vi.fn(async () => undefined);
    const h = assemble(state, {
      turn,
      claudeCreds: { getSelectedRefreshMeta, markNeedsReauth },
    });

    await withInstantHostRetryBackoff(async () => {
      await h.driver.dispatch(state.job);
      await flushUntil(() => state.job.halt?.kind === 'blocked_credentials');
    });

    // Surfaced only once the retry budget is spent — flips the credential to needs_reauth.
    expect(state.job.halt?.kind).toBe('blocked_credentials');
    expect(markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(markNeedsReauth).toHaveBeenCalledWith(
      'T1',
      'claude-cred',
      '401 Invalid API key',
    );

    // The generic `isTransientDriveError` retry loop never engages for an EngineAuthError — each
    // classify-and-retry cycle re-enters through exactly ONE runTurn call (initial + MAX_HOST_RETRIES resumes).
    expect((turn.runTurn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      MAX_HOST_RETRIES + 1,
    );

    // No paused banner during the retry window — only the durable quiet notice + live indicator fan, once
    // per retry attempt.
    const retryNotices = h.sunk.filter(
      (s) =>
        (s.block.meta as { source?: string } | null)?.source ===
        'system_notice',
    );
    expect(retryNotices).toHaveLength(MAX_HOST_RETRIES);
    expect(
      (h.liveTurns.retry as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(MAX_HOST_RETRIES);
  });

  it('resumePaused is a no-op when the job is not paused', async () => {
    const state = freshState();
    state.job.status = 'building';
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    expect(state.job.status).toBe('building'); // the ping itself does not flip a non-paused job
  });
});

// ── master_review Codex outage: HOLD (not fail) + auto re-wake + "ship without review" escape hatch ──

describe('ThreadDriver — master_review Codex-outage hold', () => {
  function masterReviewState(): StoreState {
    return {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('mr', 10, 'Master review', 'idle', true)],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
  }

  it('a transient/network error exhausting the host-retry budget during master_review HOLDS (codex_review_unavailable), not failed', async () => {
    const state = masterReviewState();
    const { turn } = makeTurn({ transientFailures: MAX_HOST_RETRIES + 1 });
    const h = assemble(state, { turn });

    await withInstantHostRetryBackoff(async () => {
      await h.driver.dispatch(state.job);
      await flushUntil(
        () => state.job.halt?.kind === 'codex_review_unavailable',
      );
    });

    expect(state.job.halt?.kind).toBe('codex_review_unavailable');
    expect(state.threads[0].status).not.toBe('done');
  });

  it('the SAME fatal Codex auth error while a BUILDER (not master_review) is in flight stays blocked_credentials', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const turn = {
      runTurn: vi.fn(async () => {
        throw new EngineAuthError(
          'Codex is unreachable',
          'sess',
          'codex',
          true,
        );
      }),
      canReattach: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.halt?.kind === 'blocked_credentials');

    expect(state.job.halt?.kind).toBe('blocked_credentials');
  });

  it('surfaces a not-done master_review as advisory on the ship-review card', async () => {
    const state = masterReviewState();
    const { turn } = makeTurn({ completeThread: false });
    const h = assemble(state, { turn, autoShipApprove: false });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'ready');

    expect(state.job.status).toBe('ready');
    expect(state.threads[0].condition).toBe('incomplete');
    const card = (
      h.store.parkForShipReview as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[1] as
      | {
          verifications?: Array<{
            title: string;
            status: string;
            unverified: boolean;
          }>;
        }
      | undefined;
    expect(card?.verifications).toEqual([
      {
        title: 'Master review',
        status: 'not_done',
        verification: [],
        unverified: false,
      },
    ]);
  });

  it('operatorShipWithoutReview REFUSES when the job is not on a codex_review_unavailable hold', async () => {
    const state = masterReviewState(); // no halt at all
    const h = assemble(state);

    const r = await h.driver.operatorShipWithoutReview(state.job.id);
    expect(r.ok).toBe(false);
    expect(h.store.recordThreadTermination).not.toHaveBeenCalled();

    state.job.halt = { kind: 'blocked_credentials' };
    const r2 = await h.driver.operatorShipWithoutReview(state.job.id);
    expect(r2.ok).toBe(false);
    expect(h.store.recordThreadTermination).not.toHaveBeenCalled();
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
      threads: [thread('mr', 90, 'Master review', 'idle', true)],
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
    ).buildTurnBridge(
      makeJob(),
      t,
      { channel: 'C1', threadTs: 't1' },
      deadline,
      sandbox,
      null,
      'sha0',
    );
  }

  it('exposes the task_* tool set for EVERY thread (builder + master-review) — Claude native is disabled', () => {
    const h = assemble(baseState());
    for (const t of [
      thread('mr', 90, 'Master review', 'idle', true),
      thread('be', 10, 'Backend'),
    ]) {
      const tools = bridgeFor(h, t).tools;
      expect(typeof tools.task_create).toBe('function');
      expect(typeof tools.task_update).toBe('function');
      expect(typeof tools.task_list).toBe('function');
      expect(typeof tools.task_get).toBe('function');
    }
  });

  // Drift guard: every tool a turn bridge actually registers MUST have a TOOL_SHAPES entry, or the
  // Claude SDK bridge would silently strip every argument that tool's handler reads (a strict zod
  // object drops unknown keys before the handler ever sees them). `__`-prefixed tools (e.g.
  // `__profile_awareness`) are reserved-internal: invoked only via the raw `bridgeCall` round-trip and
  // filtered out of `toolBridgeTools` before the container builds an SDK proxy tool, so they never pass
  // through TOOL_SHAPES and are exempt from this guard.
  it('every buildTurnBridge()-registered tool (master-review + builder) has a TOOL_SHAPES entry', () => {
    const h = assemble(baseState());
    const masterReviewTools = bridgeFor(
      h,
      thread('mr', 90, 'Master review', 'idle', true),
    ).tools;
    const builderTools = bridgeFor(h, thread('be', 10, 'Backend')).tools;
    for (const tools of [masterReviewTools, builderTools]) {
      for (const name of Object.keys(tools)) {
        if (name.startsWith('__')) continue;
        expect(
          TOOL_SHAPES,
          `driver tool "${name}" must have a TOOL_SHAPES entry`,
        ).toHaveProperty(name);
      }
    }
  });

  it('task_create writes the row through the sink and returns the durable id string to the model', async () => {
    const h = assemble(baseState());
    const tools = bridgeFor(
      h,
      thread('mr', 90, 'Master review', 'idle', true),
    ).tools;

    const r1 = await tools.task_create({
      subject: 'Review the merged diff',
      activeForm: 'Reviewing the merged diff',
    });
    const r2 = await tools.task_create({ subject: 'Apply fixes' });
    await tools.task_update({ taskId: '1', status: 'in_progress' });

    // The create result echoes the sink's returned id in the `Task #<id> created: <subject>` contract the
    // web's `createdTaskId` regex parses (the fake sink hands back sequential ids "1", "2").
    expect(r1).toBe('Task #1 created: Review the merged diff');
    expect(r2).toBe('Task #2 created: Apply fixes');

    // All writes landed on the master-review THREAD scope, via the same sink every thread lane uses.
    expect(
      h.taskEvents.map((e) => [e.method, e.scope.kind, e.scope.id]),
    ).toEqual([
      ['createTask', 'thread', 'mr'],
      ['createTask', 'thread', 'mr'],
      ['updateTask', 'thread', 'mr'],
    ]);
    expect(h.taskEvents[2].input).toMatchObject({
      taskId: '1',
      status: 'in_progress',
    });
  });

  it('rejects a task_create with no subject and a task_update with no taskId (no sink write)', async () => {
    const h = assemble(baseState());
    const tools = bridgeFor(
      h,
      thread('mr', 90, 'Master review', 'idle', true),
    ).tools;
    expect(await tools.task_create({})).toMatchObject({ ok: false });
    expect(await tools.task_update({})).toMatchObject({ ok: false });
    expect(h.taskEvents).toHaveLength(0);
  });
});

// ── Leg rotation (context-rot mitigation): fat builder session → handoff → fresh Leg continues ──────

describe('ThreadDriver — Leg rotation (context-rot mitigation)', () => {
  /** Stateful Leg-rotation store overlay on the default fake: `completeLegRotation` stashes the seed (which
   *  the fresh builder thread reads from its own config) and reports the leg transition. */
  function wireRotationStore(h: ReturnType<typeof assemble>): {
    rotations: () => number;
  } {
    let rotations = 0;
    (
      h.store.completeLegRotation as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async (inp: {
        anchorStepId: string;
        handoff: string;
        seed: string;
        rotationCapped?: boolean;
      }) => {
        const anchorThreadId =
          h.state.steps.find((step) => step.id === inp.anchorStepId)
            ?.threadId ?? inp.anchorStepId;
        const current = h.state.threads.find((t) => t.id === anchorThreadId);
        if (!current) return null;
        const rootId = current.parentThreadId ?? current.id;
        const threadGroupId =
          (current.config?.threadGroupId as string | undefined) ?? `thread-group-${rootId}`;
        const siblings = h.state.threads
          .filter(
            (thread) =>
              thread.kind === 'builder' &&
              (thread.id === rootId || thread.parentThreadId === rootId),
          )
          .sort((a, b) => a.ordinal - b.ordinal);
        const fromIndex = siblings.findIndex(
          (thread) => thread.id === current.id,
        );
        const fromLeg = fromIndex >= 0 ? fromIndex + 1 : siblings.length;
        const toLeg = fromLeg + 1;
        const maxOrdinal = siblings.reduce(
          (max, thread) => Math.max(max, thread.ordinal),
          0,
        );
        current.config = {
          ...(current.config ?? {}),
          threadGroupId,
          threadGroupKind: 'build',
        };
        h.state.threads.push({
          ...current,
          id: `${rootId}-leg-${toLeg}`,
          ordinal: maxOrdinal + 10,
          status: 'idle',
          condition: 'none',
          parentThreadId: rootId,
          handoffIn: inp.handoff,
          handoffOut: null,
          plan: null,
          orientation: null,
          config: {
            ...(current.config ?? {}),
            threadGroupId,
            threadGroupKind: 'build',
            pendingLegSeed: inp.seed,
            ...(inp.rotationCapped ? { rotationCapped: true } : {}),
          },
        });
        rotations += 1;
        return { fromLeg, toLeg, abandonedSessionId: 'sess-fat' };
      },
    );
    return { rotations: () => rotations };
  }

  function mkResult(
    input: { jobId: string; stepId?: string | null; mode: string },
    report: string,
  ) {
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
        capturedTasks.push(input.task);
        buildLeg += 1;
        if (buildLeg === 1) {
          // Leg 1: the batch turn IS steerable (armed), and it exposes the handoff tool. Simulate the context
          // filling past the soft threshold, then the model self-authoring its handoff and YIELDING (no complete_thread).
          expect(input.steerable).toBe(true);
          expect(input.toolBridge?.tools?.['record_leg_handoff']).toBeTypeOf(
            'function',
          );
          input.onEvent?.({
            kind: 'usage',
            contextTokens: 210_000,
            contextLimit: 1_000_000,
          });
          const ack = await input.toolBridge!.tools['record_leg_handoff']({
            handoff:
              'Scope: edited src/foo.ts (WIP).\nFAILED: `pnpm build` → TS2345 assign string to number.\nNext: finish the return type.',
          });
          expect(ack).toMatchObject({ ok: true }); // the tool tells the model to STOP
          return mkResult(input, 'leg 1 handed off');
        }
        // Leg 2 (fresh session, seeded): finish the batch.
        await input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'finished on the fresh Leg',
        });
        return mkResult(input, 'leg 2 done');
      },
    );
    const turn = {
      runTurn,
      canReattach: () => false,
      canSteer: () => false,
    } as unknown as TurnRunnerService;

    const h = assemble(state, { turn });
    const rot = wireRotationStore(h);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

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
    expect(state.job.status).toBe('pr_open');
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
        buildLeg += 1;
        // The one build Leg runs fat (crosses soft → the engine-local nudge fires + the driver records a visible
        // row) but NEVER calls record_leg_handoff. Under no-forced-rotation it just finishes normally.
        input.onEvent?.({
          kind: 'usage',
          contextTokens: 210_000,
          contextLimit: 1_000_000,
        });
        await input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'finished fat, no handoff',
        });
        return mkResult(input, 'leg 1 done fat');
      },
    );
    const turn = {
      runTurn,
      canReattach: () => false,
      canSteer: () => false,
    } as unknown as TurnRunnerService;

    const h = assemble(state, { turn });
    const rot = wireRotationStore(h);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');

    // No read-only fallback turn exists anymore, no rotation happened, and only ONE build Leg ran.
    expect(modes).not.toContain('review');
    expect(rot.rotations()).toBe(0);
    expect(h.store.completeLegRotation).not.toHaveBeenCalled();
    expect(buildLeg).toBe(1);
    // …but the SOFT nudge was mirrored into the transcript as a VISIBLE per-Leg harness row.
    expect(h.store.recordBuildSystemChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'system_reminder',
        legOrdinal: 1,
        phaseId: expect.any(String),
      }),
    );
    expect(state.job.status).toBe('pr_open');
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
    await flushUntil(() => state.job.status === 'pr_open');

    expect(rot.rotations()).toBe(0);
    expect(h.store.completeLegRotation).not.toHaveBeenCalled();
    expect(state.job.status).toBe('pr_open');
  });

  it('arms steerable on the CAPPED final Leg too (rotation null) — every Claude builder Leg is host-steerable', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const steerableFlags: Array<boolean | undefined> = [];
    let buildLeg = 0;
    let cappedLegSteerable: boolean | undefined;
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
        buildLeg += 1;
        steerableFlags.push(input.steerable);
        // The `toolBridge` (and its `record_leg_handoff` tool) is built ONCE outside the rotation loop and
        // reused across every Leg of this batch — so its mere presence can't distinguish the capped final
        // Leg. Instead, gate on the Leg count directly: self-author a handoff on every one of the first
        // MAX_LEGS_PER_BATCH (8) Legs so the loop rotates until it hits the cap; the 9th kick IS the capped
        // final Leg (rotation disarmed) — finish it via `complete_thread` and capture its `steerable` flag.
        if (buildLeg <= 8) {
          input.onEvent?.({
            kind: 'usage',
            contextTokens: 210_000,
            contextLimit: 1_000_000,
          });
          await input.toolBridge!.tools['record_leg_handoff']({
            handoff: `Leg ${buildLeg}: WIP.\nNext: keep going.`,
          });
          return mkResult(input, `leg ${buildLeg} handed off`);
        }
        cappedLegSteerable = input.steerable;
        await input.toolBridge?.tools?.['complete_thread']?.({
          summary: 'finished on the capped Leg',
        });
        return mkResult(input, `leg ${buildLeg} done (capped)`);
      },
    );
    const turn = {
      runTurn,
      canReattach: () => false,
      canSteer: () => false,
    } as unknown as TurnRunnerService;
    const h = assemble(state, { turn });
    wireRotationStore(h);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'pr_open');
    // The capped final Leg ran with rotation disarmed but was STILL steerable.
    expect(cappedLegSteerable).toBe(true);
    // Every Claude builder Leg (armed AND capped) forwarded steerable:true.
    expect(steerableFlags.every((f) => f === true)).toBe(true);
    expect(buildLeg).toBe(9); // 8 rotating Legs + the capped final Leg
    expect(state.job.status).toBe('pr_open');
  });
});

describe('ThreadDriver.reattachTurnRow — watchdog-triggered build reattach', () => {
  type Row = Parameters<ThreadDriver['reattachTurnRow']>[0];
  const stepRow = (jobId: string): Row =>
    ({ turn_id: 't-step', job_id: jobId, kind: 'step' }) as unknown as Row;

  it("DEFERS a non-running job (runJob's chokepoint) without driving", async () => {
    const state: StoreState = {
      job: makeJob({ status: 'pr_open' }),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await expect(h.driver.reattachTurnRow(stepRow(state.job.id))).resolves.toBe(
      'deferred',
    );
    // No drive was kicked — a non-drivable job keeps its existing recovery path.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
  });

  it('short-circuits to attached when a drive is already in flight (the shared `active` guard, no double-drive)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);
    // Simulate a drive already running for this job (boot resume / a prior wake).
    (h.driver as unknown as { active: Set<string> }).active.add(state.job.id);

    await expect(h.driver.reattachTurnRow(stepRow(state.job.id))).resolves.toBe(
      'attached',
    );
    // The active guard means the watchdog wake did NOT kick a second drive.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
  });

  it('a running, un-halted job is driven to reattach (returns attached and the build progresses)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
      operatorInputCards: [],
    };
    const h = assemble(state);

    await expect(h.driver.reattachTurnRow(stepRow(state.job.id))).resolves.toBe(
      'attached',
    );
    // The wake kicked a real drive: it fast-forwards/executes and walks the build to done.
    await flushUntil(() => state.job.status === 'pr_open');
    expect(h.calls.filter((c) => c.mode === 'execute').length).toBeGreaterThan(
      0,
    );
  });
});
