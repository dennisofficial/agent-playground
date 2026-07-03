import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import { EngineAuthError } from '../engine';
import type { EngineRunnerPort, ToolBridgeOptions } from '../engine';
import { ThreadDriver, shortReason } from './thread-driver.service';
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
import type { LeaderElectionService } from '../cluster';
import type { EnvService } from '@core/config/env/env.service';
import type {
  DecisionRecord,
  Step,
  StepStatus,
  Thread,
  ThreadStatus,
  Job,
} from '../domain';
import type { ThreadTerminalRecord } from '../persistence/entities';

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

interface StoreState {
  job: Job;
  record: DecisionRecord | null;
  threads: DriverThread[];
  steps: Step[];
  route: JobRoute;
  operatorInputCards: OperatorInputCard[];
}

function makeStore(state: StoreState): {
  store: DriverStoreService;
  state: StoreState;
} {
  let nextQuestionId = 1;
  const store = {
    loadJob: vi.fn(async () => ({ ...state.job })),
    runningJobs: vi.fn(async () =>
      state.job.status === 'running' ? [{ ...state.job }] : [],
    ),
    setJobStatus: vi.fn(async (_id: string, status: Job['status']) => {
      state.job.status = status;
    }),
    setFeatureBranch: vi.fn(async (_id: string, branch: string) => {
      state.job.featureBranch = branch;
    }),
    setPrReady: vi.fn(async (_id: string, prUrl: string) => {
      state.job.prUrl = prUrl;
      state.job.status = 'done';
    }),
    // Decision-ledger promotion spine (no-op fakes — the ledger turn itself is stubbed via ModuleRef).
    claimLedgerPromotion: vi.fn(async () => true),
    setLedgerPromotionStatus: vi.fn(async () => undefined),
    markLedgerPromoted: vi.fn(async () => undefined),
    decisionRecord: vi.fn(async () => state.record),
    threadsForJob: vi.fn(async () => state.threads.map((s) => ({ ...s }))),
    setThreadStatus: vi.fn(async (id: string, status: ThreadStatus) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.status = status;
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
    // Review-agent status writes — no-ops for the driver flow tests (display state only).
    seedReviewAgents: vi.fn(async () => undefined),
    setReviewAgentStatus: vi.fn(async () => undefined),
    finalizeReviewAgents: vi.fn(async () => undefined),
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
  } as unknown as DriverStoreService;
  return { store, state };
}

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
    commitAll: vi.fn(async (_wt: string, message: string) => {
      commits.push(message);
      return `commit${++sha}`;
    }),
    push: vi.fn(async (sandbox: FeatureSandbox) => {
      pushed.push(sandbox.branch);
    }),
  } as unknown as LocalGitService;
  return { git, pushed, commits };
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
  opts: { completeThread?: boolean; transientFailures?: number } = {},
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
        // Simulate the orchestrator's terminal assertion (what a real build turn MUST do).
        if (completeThread && input.toolBridge?.tools?.['complete_thread']) {
          await input.toolBridge.tools['complete_thread']({
            summary: `built step ${input.stepId}`,
            verification: [
              { kind: 'test', command: 'pnpm test', exitCode: 0, outputTail: 'ok' },
            ],
          });
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
}
function makeAutofix(): AutofixHandle {
  const autofixThread = vi.fn(async () => cleanSummary('thread'));
  const autofixPullRequest = vi.fn(async () => cleanSummary('pull_request'));
  return {
    autofix: { autofixThread, autofixPullRequest } as unknown as AutoFixStage,
    autofixThread,
    autofixPullRequest,
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
    status: 'running',
    decisionRecordId: 'dr-1',
    featureBranch: null,
    prUrl: null,
    prNumber: null,
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
    isMasterReview,
  };
}

/** Assemble a driver over a given store-state + collaborators; returns everything the tests assert on. */
function assemble(
  state: StoreState,
  opts: {
    env?: Record<string, string>;
    turn?: TurnRunnerService;
    turnRegistry?: Pick<import('../sandbox/turn-registry.service').TurnRegistry, 'listRunning'>;
  } = {},
) {
  const { store } = makeStore(state);
  const repos = makeRepoResolver();
  const { git, pushed, commits } = makeGit();
  const { pr, opened } = makePr();
  const made = makeTurn();
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
  const liveTurns = { push: vi.fn(), end: vi.fn() } as unknown as LiveTurnStore;
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
      },
    ),
  } as unknown as BlockSink;
  // Task-event capture isn't under test here (see turn-harness.service.spec.ts) — a no-op fake.
  const taskSink = { applyTaskEvent: vi.fn(async () => undefined) } as unknown as TaskEventSink;
  const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, taskSink);
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
  // LeaderElectionService stub: `draining` is flippable so the shutdown-guard test can simulate SIGTERM.
  const electionState = { draining: false };
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
      anthropicKey: async () => undefined,
      openaiKey: async () => undefined,
      githubToken: async () => undefined,
      engineAuth: async () => ({ secret: 'test-secret' }),
    } as unknown as CredentialResolver,
    // JobLifecycleService: returns the thread's pre-provisioned sandbox — the ONLY sandbox path now
    // (the brain provisions every thread before any build runs). Its branch is the source of truth.
    {
      ensureContainer: async () => ({
        sandbox: {
          repoId: 'proj',
          branch: 'atlas/feature-job-abcd',
          worktreePath: '/wt/atlas/feature-job-abcd',
          gitUrl: REPO.gitUrl,
          token: 'ghtok',
        },
        wasReset: false,
      }),
      findSandbox: async () => null,
      recordPr: async () => undefined,
    } as unknown as import('./job-lifecycle.service').JobLifecycleService,
    // BuildShipService: the real terminal "ship" over the same git/pr/store fakes, so the push/open/
    // setPrReady assertions hold exactly as before the extraction. The open-PR turn runs on the same shared
    // `turnHarness` + the dedicated `engineRunner` fake above.
    new BuildShipService(git, pr, store, turnHarness, engineRunner),
    // PipelineAwarenessStore: append is a best-effort no-op (passive milestones not asserted here).
    {
      appendMarker: async () => undefined,
      drainAndAdvance: async () => ({ markers: [], stateChanged: false }),
    } as unknown as import('./pipeline-awareness.store').PipelineAwarenessStore,
    // LeaderElectionService: reads the flippable `electionState.draining` so the shutdown-guard test can
    // assert that a drain-induced abort leaves the job `running` instead of `failed`.
    {
      isDraining: () => electionState.draining,
    } as unknown as LeaderElectionService,
    turnHarness,
    blockSink,
    // TurnRegistry: no in-flight rows by default (fresh runs) — reattach lookup returns empty. A reattach
    // test overrides `listRunning` to surface a matching in-flight `step` row.
    (opts.turnRegistry ?? {
      listRunning: async () => [],
    }) as unknown as import('../sandbox/turn-registry.service').TurnRegistry,
    // ModuleRef: the lazy brain lookup → a stub promoter (the ledger turn is exercised in the brain specs).
    {
      get: () => ({ promoteDurableDecisionsAtShip: async () => undefined }),
    } as unknown as ModuleRef,
  );
  return {
    driver,
    store,
    state,
    git,
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
    posts,
    liveTurns,
    blockSink,
    sunk,
    electionState,
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

    // Per-thread auto-fix ran once per thread; Atlas opens the PR in-sandbox — ONE ship engine turn (master
    // review no longer runs in ship; it's now a Codex build thread, absent from this mock's thread list).
    expect(h.autofix.autofixThread).toHaveBeenCalledTimes(2);
    expect(h.engineCalls).toEqual([{ mode: 'execute', engine: 'claude' }]);

    // Both threads are done with a handoff; the SECOND thread received the first's handoff.
    expect(state.threads.every((s) => s.status === 'done')).toBe(true);
    expect(state.threads[1].handoffIn).toContain('Backend');

    // ONE branch — threads stacked on the same feature branch (the host never pushes; Atlas pushes
    // in-sandbox as part of the ship turn, which ran).
    expect(state.job.featureBranch).toBe('atlas/feature-job-abcd');
    expect(
      h.engineCalls.filter((c) => c.mode === 'execute' && c.engine === 'claude')
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(state.job.status).toBe('done');
    expect(h.posts.some((p) => p.includes('opening the PR'))).toBe(true);
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

    // Auto-fix ran for the feature thread ONLY — the master-review thread IS the review, so it's skipped.
    expect(h.autofix.autofixThread).toHaveBeenCalledTimes(1);
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
        s.block.meta?.shipId == null,
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
      h.engineCalls.filter((c) => c.mode === 'execute' && c.engine === 'claude')
        .length,
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
      h.engineCalls.filter((c) => c.mode === 'execute' && c.engine === 'claude')
        .length,
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
    expect(h.posts.some((p) => p.includes('opening the PR'))).toBe(true);
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
    await flushUntil(() => state.job.status === 'failed');

    expect(state.job.status).toBe('failed');
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
    await flushUntil(() => state.job.status === 'paused');

    expect(state.threads[0].status).toBe('incomplete'); // halted, NOT silently done
    expect(state.job.status).toBe('paused'); // needs-you, recoverable — NOT done, NOT failed
    expect(h.opened).toHaveLength(0); // nothing shipped
    expect(
      h.posts.some((p) => p.includes('without asserting completion')),
    ).toBe(true); // a durable halt card, never a silent dead-end
    expect(h.autofix.autofixThread).not.toHaveBeenCalled(); // auto-fix skipped on a halt
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
    // The process is shutting down: the in-flight turn's host-side await is cut off → it throws like a
    // generic abort. Without the guard this would flip the job `failed` and boot-resume would never
    // re-drive it (`runningJobs()` only re-drives `status:'running'`).
    h.electionState.draining = true;
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
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
    await flushUntil(() => state.job.status === 'failed');

    expect(state.job.status).toBe('failed');
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
    await flushUntil(() => state.job.status === 'paused');

    expect(state.job.status).toBe('paused'); // paused, NOT failed
    expect(
      h.posts.some((p) => /paused/i.test(p) && /credential|auth/i.test(p)),
    ).toBe(true);
    expect(h.opened).toHaveLength(0);
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

    // resume path: a paused job is flipped to running and driven to a PR.
    const state: StoreState = {
      job: makeJob({ status: 'paused' }),
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
      h.engineCalls.filter((c) => c.mode === 'execute' && c.engine === 'claude')
        .length,
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

    // The thread's status went to 'awaiting_input' then back to 'executing' around the pause.
    const statusCalls = (h.store.setThreadStatus as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1],
    );
    expect(statusCalls).toContain('awaiting_input');
    const awaitIdx = statusCalls.indexOf('awaiting_input');
    expect(statusCalls.slice(awaitIdx + 1)).toContain('executing');

    // The build proceeded to completion carrying the answer in its report.
    expect(state.job.status).toBe('done');
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
    await flushUntil(() => state.job.status === 'paused');

    expect(state.job.status).toBe('paused'); // paused, NOT 'failed'
    expect(state.job.prUrl).toBeNull();
    expect(h.posts.some((p) => p.toLowerCase().includes('paused'))).toBe(true);

    // Boot reconciliation must NOT auto-retry a paused job (it would just 401 again).
    await h.driver.resume();
    await flushUntil(() => false, 5);
    expect(state.job.status).toBe('paused');

    // PING → resume the SAME session → drive to completion (one PR).
    await h.driver.resumePaused(state.job.id);
    await flushUntil(() => state.job.status === 'done');

    expect(state.job.status).toBe('done');
    expect(
      h.engineCalls.filter((c) => c.mode === 'execute' && c.engine === 'claude')
        .length,
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
