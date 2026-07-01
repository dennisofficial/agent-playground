import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ModuleRef } from '@nestjs/core';
import { EngineAuthError } from '../engine';
import { ThreadDriver } from './thread-driver.service';
import { BuildShipService } from './build-ship.service';
import type {
  DriverStoreService,
  DriverThread,
  JobRoute,
} from './driver-store.service';
import type { PlannerLlm, PlannedStep } from './planner-llm';
import type { DriverRepoResolver, ResolvedRepo } from './repo-resolver';
import type {
  DecisionClassifier,
  ParkAndAskService,
  ParkHandle,
  ParkResolution,
  PlanVisibilityService,
} from '../decision-gate';
import type { AutoFixStage } from '../autofix';
import type {
  GithubPrService,
  LocalGitService,
  FeatureSandbox,
  ProjectRepo,
} from '../git';
import type { TurnRunnerService } from '../runner';
import type { BlockSink, ChatSurface, LiveTurnStore } from '../surface';
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

/**
 * W4 — the SECTION/PHASE DRIVER unit tests. Every dependency is mocked (NO real LLM / git / network):
 * the driver walks a 2-thread / multi-step job to ONE PR; an uncovered always-ask decision PARKS and
 * resumes on a simulated human answer; step step-state persists; `resume()` fast-forwards completed
 * work after a simulated restart; threads share one branch ⇒ one PR.
 *
 * The store is an in-memory fake the test can re-instantiate a fresh driver against — that's how the
 * resumability test simulates a process restart (same rows, new driver). Zero real I/O.
 */

// ── an in-memory DriverStore the tests can introspect + survive a "restart" ──────────────────────

interface StoreState {
  job: Job;
  record: DecisionRecord | null;
  threads: DriverThread[];
  steps: Step[];
  route: JobRoute;
}

function makeStore(state: StoreState): {
  store: DriverStoreService;
  state: StoreState;
} {
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
    setThreadHandoffOut: vi.fn(async (id: string, handoffOut: string) => {
      const s = state.threads.find((x) => x.id === id);
      if (s) s.handoffOut = handoffOut;
    }),
    // Review-agent status writes — no-ops for the driver flow tests (display state only).
    seedReviewAgents: vi.fn(async () => undefined),
    setReviewAgentStatus: vi.fn(async () => undefined),
    finalizeReviewAgents: vi.fn(async () => undefined),
    seedJobReviewAgents: vi.fn(async () => undefined),
    setJobReviewAgentStatus: vi.fn(async () => undefined),
    finalizeJobReviewAgents: vi.fn(async () => undefined),
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
  } as unknown as GithubPrService;
  return { pr, opened };
}

function makeTurn(): {
  turn: TurnRunnerService;
  calls: Array<{ mode: string; stepId?: string | null }>;
} {
  const calls: Array<{ mode: string; stepId?: string | null }> = [];
  const turn = {
    runTurn: vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
      }) => {
        calls.push({ mode: input.mode, stepId: input.stepId });
        return {
          report:
            input.mode === 'plan'
              ? 'I will build it in steps.'
              : `did step ${input.stepId}`,
          ...(input.mode === 'plan' ? { planText: 'PLAN: do the thing' } : {}),
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

/** A planner that emits a fixed 2-step plan per thread. */
function makePlanner(): PlannerLlm {
  return {
    planThread: vi.fn(async (input: { brief: string }) => [
      { title: `${input.brief} — step A`, brief: 'do A' },
      { title: `${input.brief} — step B`, brief: 'do B' },
    ]),
    reviewPlan: vi.fn(async () => undefined), // no revision
    extractDecisions: vi.fn(async () => []), // no notable decision by default
    handoff: vi.fn(
      async (input: { brief: string }) => `handoff from ${input.brief}`,
    ),
    // Default: no grouping → the driver's guardrail falls back to one batch per step (preserves the
    // pre-batching behavior these tests assert). Batching-specific tests override this mock.
    batchSteps: vi.fn(async () => undefined),
  };
}

function makeClassifier(
  verdict: 'covered' | 'proceed' | 'ask' = 'proceed',
): DecisionClassifier {
  return {
    classify: vi.fn(async () => ({
      verdict,
      reason: 'r',
      via: 'rule' as const,
    })),
  } as unknown as DecisionClassifier;
}

function makePark(answer?: Promise<ParkResolution>): {
  park: ParkAndAskService;
  ask: ReturnType<typeof vi.fn>;
} {
  const ask = vi.fn(
    async (): Promise<ParkHandle> => ({
      id: 'park1',
      questionTs: 'q1',
      threadTs: 't1',
      answer:
        answer ??
        Promise.resolve({
          parkId: 'park1',
          text: 'yes go ahead',
          authorId: 'U1',
          ts: 'a1',
        }),
      resolved: false,
    }),
  );
  return { park: { ask } as unknown as ParkAndAskService, ask };
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
): DriverThread {
  return {
    id,
    jobId: 'job-abcdef12',
    orgId: 'T1',
    ordinal,
    brief,
    plan: null,
    handoffIn: null,
    handoffOut: null,
    status,
  };
}

/** Assemble a driver over a given store-state + collaborators; returns everything the tests assert on. */
function assemble(
  state: StoreState,
  opts: {
    classifierVerdict?: 'covered' | 'proceed' | 'ask';
    parkAnswer?: Promise<ParkResolution>;
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
  const planner = makePlanner();
  const classifier = makeClassifier(opts.classifierVerdict);
  const { park, ask } = makePark(opts.parkAnswer);
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
  const turnHarness = new TurnHarnessFactory(liveTurns, blockSink);
  // LeaderElectionService stub: `draining` is flippable so the shutdown-guard test can simulate SIGTERM.
  const electionState = { draining: false };
  const driver = new ThreadDriver(
    store,
    repos,
    git,
    pr,
    turn,
    planner,
    classifier,
    park,
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
      brainTranscriptProjectsDir: () => null,
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
    // BuildShipService: the real terminal "ship" over the same git/pr/autofix/store fakes, so the
    // PR-tail assertions (pushed/opened/setPrReady) hold exactly as before the extraction.
    new BuildShipService(autofix.autofix, git, pr, store, {
      appendBlock: async () => undefined,
    }),
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
    planner,
    classifier,
    ask,
    visibility,
    autofix,
    surface,
    pushed,
    commits,
    opened,
    calls,
    posts,
    liveTurns,
    blockSink,
    sunk,
    electionState,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('ThreadDriver — the legible thread/step pipeline', () => {
  it('walks a 2-thread / multi-step job to ONE PR (plan → execute steps → autofix → handoff → next → PR-tail)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Both threads planned (one plan turn each). Orchestrate mode (default): each thread runs as ONE
    // orchestrator execute turn that fans its steps out to writer subagents → 2 execute turns, not 4.
    const planTurns = h.calls.filter((c) => c.mode === 'plan');
    const execTurns = h.calls.filter((c) => c.mode === 'execute');
    expect(planTurns).toHaveLength(2);
    expect(execTurns).toHaveLength(2); // 2 threads × 1 orchestrator session

    // Per-thread auto-fix ran once per thread; PR-tail ran exactly once.
    expect(h.autofix.autofixThread).toHaveBeenCalledTimes(2);
    expect(h.autofix.autofixPullRequest).toHaveBeenCalledTimes(1);

    // Both threads are done with a handoff; the SECOND thread received the first's handoff.
    expect(state.threads.every((s) => s.status === 'done')).toBe(true);
    expect(state.threads[1].handoffIn).toBe('handoff from Backend');

    // ONE branch, ONE push, ONE PR — threads stacked on the same feature branch.
    expect(new Set(h.pushed).size).toBe(1);
    expect(h.opened).toHaveLength(1);
    expect(state.job.prUrl).toBe('https://github.com/acme/widget/pull/1');
    expect(state.job.status).toBe('done');
    expect(h.posts.some((p) => p.includes('PR ready'))).toBe(true);
  });

  it('build turns ride the shared transcript spine: richStream on, blocks tagged meta.phaseId, a build_anchor per batch', async () => {
    const seen: Array<{ mode: string; richStream?: boolean }> = [];
    const turn = {
      runTurn: vi.fn(
        async (input: {
          mode: string;
          jobId: string;
          stepId?: string | null;
          richStream?: boolean;
          onEvent?: (e: { kind: string; [k: string]: unknown }) => void;
        }) => {
          seen.push({ mode: input.mode, richStream: input.richStream });
          if (input.mode === 'execute') {
            input.onEvent?.({ kind: 'thinking', text: 'planning the edit' });
            input.onEvent?.({ kind: 'text', text: 'editing the file' });
            input.onEvent?.({
              kind: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: { file_path: 'a.ts' },
            });
            input.onEvent?.({ kind: 'tool_result', id: 't1', result: 'ok' });
          }
          return {
            report: input.mode === 'plan' ? 'plan' : `did ${input.stepId}`,
            ...(input.mode === 'plan' ? { planText: 'PLAN' } : {}),
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
    };
    const h = assemble(state, { turn });
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Every EXECUTE (build) turn requested richStream (plan turns don't).
    const exec = seen.filter((c) => c.mode === 'execute');
    expect(exec.length).toBeGreaterThan(0);
    expect(exec.every((c) => c.richStream === true)).toBe(true);

    // A synthetic `build_anchor` row per batch, each tagged with its phaseId.
    const anchors = h.sunk.filter((s) => s.block.kind === 'build_anchor');
    expect(anchors.length).toBeGreaterThan(0);
    expect(
      anchors.every((a) => typeof a.block.meta?.phaseId === 'string'),
    ).toBe(true);

    // The transcript blocks landed via the durable sink — all tagged with meta.phaseId (peeled into the step).
    const transcript = h.sunk.filter((s) =>
      ['chat', 'thinking', 'tool'].includes(s.block.kind),
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
    // A single pre-locked thread whose ONLY batch already STARTED before a restart: its steps carry a
    // persisted session + batch ordinal but no commit, so the driver re-enters runBatch for that batch.
    const steps: Step[] = [0, 1].map((i) => ({
      id: `sec-be-ph${i}`,
      threadId: 'sec-be',
      jobId: 'job-abcdef12',
      ordinal: (i + 1) * 10,
      title: `P${i}`,
      brief: `do ${i}`,
      stage: 'build' as const,
      status: 'building' as StepStatus,
      sessionId: 'sess-live', // persisted at turn start → the batch is a RESUME, not a fresh start
      batchOrdinal: 1,
      commitSha: null,
    }));
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps,
      route: { channel: 'C1', threadTs: 't1' },
    };

    // A runner that CAN re-attach; `reattach` resolves the in-flight turn and `runTurn` is a spy that must
    // NOT fire for the execute batch (no re-run).
    const reattach = vi.fn(async () => ({
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
    }));
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
    // The resumed turn's transcript persisted + the batch committed → the run finishes to ONE PR.
    expect(h.opened).toHaveLength(1);
  });

  // ── §D fresh-context step batching ──────────────────────────────────────────────────────────────
  // A single thread PRE-LOCKED with N authored steps (the full-plan-up-front path): the driver finds
  // steps already present → skips JIT planning → packs the ordered steps into execution batches.
  function authoredState(n: number): StoreState {
    const steps: Step[] = Array.from({ length: n }, (_, i) => ({
      id: `sec-be-ph${i}`,
      threadId: 'sec-be',
      jobId: 'job-abcdef12',
      ordinal: (i + 1) * 10,
      title: `P${i}`,
      brief: `do ${i}`,
      stage: 'build',
      status: 'pending' as StepStatus,
      sessionId: null,
      batchOrdinal: null,
      commitSha: null,
    }));
    return {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps,
      route: { channel: 'C1', threadTs: 't1' },
    };
  }

  it('packs authored steps into batches: 5 steps → 2 sessions, one commit per batch, NO JIT plan turn', async () => {
    const state = authoredState(5);
    const h = assemble(state, { env: { ORCHESTRATE_THREADS: 'off' } }); // legacy LLM-batcher path
    (h.planner.batchSteps as ReturnType<typeof vi.fn>).mockResolvedValue([
      [0, 1, 2],
      [3, 4],
    ]);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Pre-locked steps ⇒ NO JIT plan turn; 2 batches ⇒ 2 execute turns (not 5).
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(0);
    const exec = h.calls.filter((c) => c.mode === 'execute');
    expect(exec).toHaveLength(2);
    // Each batch is anchored on its first step (the session/resume cursor).
    expect(exec.map((c) => c.stepId)).toEqual(['sec-be-ph0', 'sec-be-ph3']);
    // Every step marked done; batch_ordinal persisted (group 1 / group 2).
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
    expect(state.steps.map((p) => p.batchOrdinal)).toEqual([1, 1, 1, 2, 2]);
    // ONE commit per batch (2 build commits), then the single PR.
    expect(h.commits.filter((m) => m.startsWith('Backend —'))).toHaveLength(2);
    expect(h.opened).toHaveLength(1);
  });

  it('guardrail: an INVALID partition falls back to one batch per step', async () => {
    const state = authoredState(3);
    const h = assemble(state, { env: { ORCHESTRATE_THREADS: 'off' } }); // legacy LLM-batcher path
    (h.planner.batchSteps as ReturnType<typeof vi.fn>).mockResolvedValue([
      [0, 2],
    ]); // not covering [0,1,2]

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(3);
    expect(state.steps.map((p) => p.batchOrdinal)).toEqual([1, 2, 3]);
  });

  it('guardrail: caps a too-large group at MAX_PHASES_PER_BATCH', async () => {
    const state = authoredState(5);
    const h = assemble(state, {
      env: { MAX_PHASES_PER_BATCH: '2', ORCHESTRATE_THREADS: 'off' },
    });
    (h.planner.batchSteps as ReturnType<typeof vi.fn>).mockResolvedValue([
      [0, 1, 2, 3, 4],
    ]);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // One group of 5 capped at 2 → [0,1],[2,3],[4] → 3 sessions.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(3);
    expect(state.steps.map((p) => p.batchOrdinal)).toEqual([1, 1, 2, 2, 3]);
  });

  it('resume: batch_ordinal already set ⇒ batchSteps is NOT called again (stable membership)', async () => {
    const state = authoredState(4);
    // A prior run already batched (ordinals set) but crashed before any step finished.
    state.steps.forEach((p, i) => (p.batchOrdinal = i < 2 ? 1 : 2));
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.planner.batchSteps).not.toHaveBeenCalled();
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(2); // re-grouped from stored ordinals
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
  });

  it('every step ran in the SAME feature branch (threads share one thread sandbox)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
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

  it('an uncovered always-ask decision PARKS the thread and resumes on the human answer', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    // A human reply we resolve LATER — the thread must suspend on `handle.answer` until then.
    let resolveAnswer!: (r: ParkResolution) => void;
    const answer = new Promise<ParkResolution>((res) => {
      resolveAnswer = res;
    });
    // The planner surfaces a notable decision; the classifier says ASK → the thread parks.
    const h = assemble(state, { classifierVerdict: 'ask', parkAnswer: answer });
    (h.planner.extractDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { description: 'add a new users table' },
    ]);

    await h.driver.dispatch(state.job);
    await flush();

    // The thread parked: ask was called, the thread sits awaiting_approval, NO execute turn yet.
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(state.threads[0].status).toBe('awaiting_approval');
    expect(h.calls.some((c) => c.mode === 'execute')).toBe(false);

    // The human replies → the thread unparks and runs to completion.
    resolveAnswer({
      parkId: 'park1',
      text: 'yes, use a users table',
      authorId: 'U1',
      ts: 'a1',
    });
    await flushUntil(() => state.job.status === 'done');

    expect(h.calls.some((c) => c.mode === 'execute')).toBe(true);
    expect(state.threads[0].status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('persists resumable step step-state (each step ends done/done; session set during the turn)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    // Legacy per-step path: asserts the interleaved building→done cursor (orchestrate runs one batch/thread).
    const h = assemble(state, { env: { ORCHESTRATE_THREADS: 'off' } });
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    const steps = state.steps.filter((p) => p.threadId === 'sec-be');
    expect(steps).toHaveLength(2);
    expect(steps.every((p) => p.status === 'done' && p.stage === 'done')).toBe(
      true,
    );
    // setStepState was driven to 'building' then 'done' for each step (explicit, resumable cursor).
    expect(
      (h.store.setStepState as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[2],
      ),
    ).toEqual(['building', 'done', 'building', 'done']);
  });

  it('resume() fast-forwards completed threads/steps after a simulated restart (no re-execution)', async () => {
    // Simulate a restart MID-JOB: thread 1 (Backend) already done with a handoff + its steps done;
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
          title: 'A',
          brief: 'do A',
          stage: 'done',
          status: 'done',
          sessionId: 's',
          batchOrdinal: 1,
          commitSha: null,
        },
        {
          id: 'sec-be-ph1',
          threadId: 'sec-be',
          jobId: 'job-abcdef12',
          ordinal: 20,
          title: 'B',
          brief: 'do B',
          stage: 'done',
          status: 'done',
          sessionId: 's',
          batchOrdinal: 2,
          commitSha: null,
        },
      ],
      route: { channel: 'C1', threadTs: 't1' },
    };
    // Legacy per-step path: the pre-locked Backend steps were batched 1-per-ordinal; Frontend runs 2 steps.
    const h = assemble(state, { env: { ORCHESTRATE_THREADS: 'off' } });

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The done Backend thread was NOT re-planned and NOT re-executed (no plan/exec turn for it).
    // Only the Frontend thread planned (1 plan turn) + ran (2 exec turns).
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(1);
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(2);
    // The Frontend thread received Backend's persisted handoff.
    expect(state.threads[1].handoffIn).toBe('handoff from Backend');
    // Still ONE PR.
    expect(h.opened).toHaveLength(1);
    expect(state.job.status).toBe('done');
  });

  it('orchestrate resume: a batch whose anchor already has a commit_sha FAST-FORWARDS (no re-run) (issue #6)', async () => {
    // Crash AFTER the batch committed (commit_sha stamped on the anchor) but BEFORE the step rows flipped
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
          title: 'A',
          brief: 'do A',
          stage: 'build',
          status: 'building',
          sessionId: 's',
          batchOrdinal: 1,
          commitSha: 'abc123',
        },
        {
          id: 'sec-be-ph1',
          threadId: 'sec-be',
          jobId: 'job-abcdef12',
          ordinal: 20,
          title: 'B',
          brief: 'do B',
          stage: 'build',
          status: 'building',
          sessionId: 's',
          batchOrdinal: 1,
          commitSha: null,
        },
      ],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state); // orchestrate default

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The committed batch fast-forwarded: NO execute turn, NO new commit, both steps marked done.
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(0);
    expect(h.commits.filter((m) => m.startsWith('Backend —'))).toHaveLength(0);
    expect(state.steps.every((p) => p.status === 'done')).toBe(true);
    expect(state.job.status).toBe('done');
  });

  it('resume() re-runs an interrupted (executing) step — reopens the current step, idempotent commit', async () => {
    // A step left mid-build by a crash: status 'building'. resume() should re-run it (status not done).
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
          title: 'A',
          brief: 'do A',
          stage: 'done',
          status: 'done',
          sessionId: 's',
          batchOrdinal: 1,
          commitSha: null,
        },
        {
          id: 'sec-be-ph1',
          threadId: 'sec-be',
          jobId: 'job-abcdef12',
          ordinal: 20,
          title: 'B',
          brief: 'do B',
          stage: 'build',
          status: 'building',
          sessionId: 's2',
          batchOrdinal: 2,
          commitSha: null,
        },
      ],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The already-locked steps skip planning; only the unfinished step (B) re-runs.
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(0); // steps already locked
    const execPhaseIds = h.calls
      .filter((c) => c.mode === 'execute')
      .map((c) => c.stepId);
    expect(execPhaseIds).toEqual(['sec-be-ph1']); // only the interrupted step
    expect(state.steps.find((p) => p.id === 'sec-be-ph1')?.status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('a clean stimulus (no always-ask) proceeds without parking — covered/proceed never blocks', async () => {
    const state: StoreState = {
      job: makeJob({ kind: 'bugfix' }),
      record: makeRecord(),
      threads: [thread('sec-fix', 10, 'Fix the bug')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state, { classifierVerdict: 'covered' });
    (h.planner.extractDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { description: 'reuse the existing users table' },
    ]);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.ask).not.toHaveBeenCalled();
    expect(state.job.status).toBe('done');
    expect(h.opened).toHaveLength(1);
  });

  it('posts in-thread progress as the build advances (issue #2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: makeSections(),
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
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
    expect(h.posts.some((p) => p.includes('PR ready'))).toBe(true);
  });

  it('relays a clear "build failed — why" when a step errors, never dead-ends silently (issue #2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    // Plan turn succeeds; the execute turn explodes → must propagate to a failure relay.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string }) => {
        if (input.mode === 'plan')
          return { report: 'plan', planText: 'PLAN', session: {} };
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

  it('shutdown drain: a step error WHILE DRAINING leaves the job running (resumable on boot), never failed', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    // The process is shutting down: the in-flight turn's host-side await is cut off → it throws like a
    // generic abort. Without the guard this would flip the job `failed` and boot-resume would never
    // re-drive it (`runningJobs()` only re-drives `status:'running'`).
    h.electionState.draining = true;
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string }) => {
        if (input.mode === 'plan')
          return { report: 'plan', planText: 'PLAN', session: {} };
        throw new Error('aborted: backend draining');
      },
    );

    await h.driver.dispatch(state.job);
    // Wait until the execute turn has been attempted (so the drive catch has run), then drain a few ticks.
    await flushUntil(() =>
      (h.turn.runTurn as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[0].mode !== 'plan',
      ),
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
    };
    const h = assemble(state, { env: { PHASE_TIMEOUT_MS: '20' } });
    // Plan resolves; the execute turn NEVER settles AND ignores the abort signal (mimics the real SDK
    // stuck in a non-yielding subprocess). The HARD race-timeout must still bound the driver.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string }) => {
        if (input.mode === 'plan')
          return { report: 'plan', planText: 'PLAN', session: {} };
        return new Promise(() => {}); // never settles, never honors abort
      },
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
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string; stepId?: string | null }) => {
        if (input.mode === 'plan')
          return { report: 'plan', planText: 'PLAN', session: {} };
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

  it('fails + relays a park that is never answered (PARK_TIMEOUT_MS) instead of hanging forever', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const never = new Promise<ParkResolution>(() => {}); // the human never answers
    const h = assemble(state, {
      classifierVerdict: 'ask',
      parkAnswer: never,
      env: { PARK_TIMEOUT_MS: '20' },
    });
    (h.planner.extractDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { description: 'add a new users table' },
    ]);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'failed');

    expect(h.ask).toHaveBeenCalledTimes(1); // it did park
    expect(state.job.status).toBe('failed'); // but did NOT hang — timed out
    expect(
      h.posts.some(
        (p) => p.includes('Build failed') && /waiting for your input/i.test(p),
      ),
    ).toBe(true);
    expect(h.calls.some((c) => c.mode === 'execute')).toBe(false); // never got past the gate
    expect(h.opened).toHaveLength(0);
  });

  it('PAUSES the job (not failed) on an EngineAuthError and relays a pause notice (resume feature)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string }) => {
        if (input.mode === 'plan')
          return { report: 'plan', planText: 'PLAN', session: {} };
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
    };
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    await flushUntil(() => state.job.status === 'done');
    expect(state.job.status).toBe('done');
    expect(h.opened).toHaveLength(1);
  });

  it('bounds a runaway thread PLAN turn — aborts + falls back to the planner, no hang (issue #3)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      threads: [thread('sec-be', 10, 'Backend')],
      steps: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state, { env: { PHASE_TIMEOUT_MS: '20' } });
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string; stepId?: string | null }) => {
        // The plan turn NEVER settles and ignores abort (a runaway read-only exploration the SDK won't
        // interrupt). The hard race-timeout must bound it and fall back to the planner.
        if (input.mode === 'plan') return new Promise(() => {});
        return { report: `did ${input.stepId}`, session: {} };
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The plan turn timed out but the build did NOT hang: the structured planner supplied steps and
    // execution proceeded to completion (steps committed, one PR opened).
    expect(state.job.status).toBe('done');
    expect(h.commits.length).toBeGreaterThan(0);
    expect(h.opened).toHaveLength(1);
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

/** Spin the event loop until a predicate holds (or a cap), for the park/resume cases. */
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
        }) => {
          if (input.mode === 'execute' && ++executes === 1) {
            throw new EngineAuthError('401 Invalid API key', 'sess-401');
          }
          return {
            report: input.mode === 'plan' ? 'plan' : `did ${input.stepId}`,
            ...(input.mode === 'plan' ? { planText: 'P' } : {}),
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
    expect(h.opened).toHaveLength(1);
    expect(state.job.prUrl).toBe('https://github.com/acme/widget/pull/1');
  });

  it('resumePaused is a no-op when the job is not paused', async () => {
    const state = freshState();
    state.job.status = 'running';
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    expect(state.job.status).toBe('running'); // the ping itself does not flip a non-paused job
  });
});
