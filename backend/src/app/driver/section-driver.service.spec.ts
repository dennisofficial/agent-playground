import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { EngineAuthError } from '../engine';
import { SectionDriver } from './section-driver.service';
import { BuildShipService } from './build-ship.service';
import type { DriverStoreService, DriverSection, JobRoute } from './driver-store.service';
import type { PlannerLlm, PlannedPhase } from './planner-llm';
import type { DriverRepoResolver, ResolvedRepo } from './repo-resolver';
import type {
  DecisionClassifier,
  ParkAndAskService,
  ParkHandle,
  ParkResolution,
  PlanVisibilityService,
} from '../decision-gate';
import type { AutoFixStage } from '../autofix';
import type { GithubPrService, LocalGitService, FeatureSandbox, ProjectRepo } from '../git';
import type { TurnRunnerService } from '../runner';
import type { ChatSurface } from '../surface';
import type { CredentialResolver } from '../onboarding';
import type { EnvService } from '@core/config/env/env.service';
import type {
  DecisionRecord,
  Phase,
  PhaseStatus,
  Section,
  SectionStatus,
  Thread,
} from '../domain';

/**
 * W4 — the SECTION/PHASE DRIVER unit tests. Every dependency is mocked (NO real LLM / git / network):
 * the driver walks a 2-section / multi-phase job to ONE PR; an uncovered always-ask decision PARKS and
 * resumes on a simulated human answer; phase step-state persists; `resume()` fast-forwards completed
 * work after a simulated restart; sections share one branch ⇒ one PR.
 *
 * The store is an in-memory fake the test can re-instantiate a fresh driver against — that's how the
 * resumability test simulates a process restart (same rows, new driver). Zero real I/O.
 */

// ── an in-memory DriverStore the tests can introspect + survive a "restart" ──────────────────────

interface StoreState {
  job: Thread;
  record: DecisionRecord | null;
  sections: DriverSection[];
  phases: Phase[];
  route: JobRoute;
}

function makeStore(state: StoreState): { store: DriverStoreService; state: StoreState } {
  const store = {
    loadJob: vi.fn(async () => ({ ...state.job })),
    runningJobs: vi.fn(async () => (state.job.status === 'running' ? [{ ...state.job }] : [])),
    setJobStatus: vi.fn(async (_id: string, status: Thread['status']) => {
      state.job.status = status;
    }),
    setFeatureBranch: vi.fn(async (_id: string, branch: string) => {
      state.job.featureBranch = branch;
    }),
    setPrReady: vi.fn(async (_id: string, prUrl: string) => {
      state.job.prUrl = prUrl;
      state.job.status = 'done';
    }),
    decisionRecord: vi.fn(async () => state.record),
    sectionsForJob: vi.fn(async () => state.sections.map((s) => ({ ...s }))),
    setSectionStatus: vi.fn(async (id: string, status: SectionStatus) => {
      const s = state.sections.find((x) => x.id === id);
      if (s) s.status = status;
    }),
    setSectionPlan: vi.fn(async (id: string, plan: string, handoffIn: string | null) => {
      const s = state.sections.find((x) => x.id === id);
      if (s) {
        s.plan = plan;
        s.handoffIn = handoffIn;
      }
    }),
    setSectionHandoffOut: vi.fn(async (id: string, handoffOut: string) => {
      const s = state.sections.find((x) => x.id === id);
      if (s) s.handoffOut = handoffOut;
    }),
    phasesForSection: vi.fn(async (sectionId: string) =>
      state.phases.filter((p) => p.sectionId === sectionId).map((p) => ({ ...p })),
    ),
    lockPhases: vi.fn(async (section: DriverSection, planned: PlannedPhase[]) => {
      const existing = state.phases.filter((p) => p.sectionId === section.id);
      if (existing.length) return existing.map((p) => ({ ...p }));
      const rows: Phase[] = planned.map((p, i) => ({
        id: `${section.id}-ph${i}`,
        sectionId: section.id,
        threadId: section.threadId,
        ordinal: (i + 1) * 10,
        title: p.title,
        brief: p.brief,
        step: 'build',
        status: 'pending' as PhaseStatus,
        sessionId: null,
      }));
      state.phases.push(...rows);
      return rows.map((p) => ({ ...p }));
    }),
    setPhaseState: vi.fn(async (id: string, step: string, status: PhaseStatus) => {
      const p = state.phases.find((x) => x.id === id);
      if (p) {
        p.step = step;
        p.status = status;
      }
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

function makeGit(): { git: LocalGitService; pushed: string[]; commits: string[] } {
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
      return { url: 'https://github.com/acme/widget/pull/1', number: 1, existing: false };
    }),
  } as unknown as GithubPrService;
  return { pr, opened };
}

function makeTurn(): { turn: TurnRunnerService; calls: Array<{ mode: string; phaseId?: string | null }> } {
  const calls: Array<{ mode: string; phaseId?: string | null }> = [];
  const turn = {
    runTurn: vi.fn(async (input: { mode: string; phaseId?: string | null; jobId: string }) => {
      calls.push({ mode: input.mode, phaseId: input.phaseId });
      return {
        report: input.mode === 'plan' ? 'I will build it in phases.' : `did phase ${input.phaseId}`,
        ...(input.mode === 'plan' ? { planText: 'PLAN: do the thing' } : {}),
        session: {
          id: 'sess',
          jobId: input.jobId,
          phaseId: input.phaseId ?? null,
          engine: 'claude' as const,
          mode: input.mode as 'plan' | 'execute' | 'review',
          branch: 'b',
          worktreePath: '/wt/b',
        },
      };
    }),
  } as unknown as TurnRunnerService;
  return { turn, calls };
}

/** A planner that emits a fixed 2-phase plan per section. */
function makePlanner(): PlannerLlm {
  return {
    planSection: vi.fn(async (input: { brief: string }) => [
      { title: `${input.brief} — phase A`, brief: 'do A' },
      { title: `${input.brief} — phase B`, brief: 'do B' },
    ]),
    reviewPlan: vi.fn(async () => undefined), // no revision
    extractDecisions: vi.fn(async () => []), // no notable decision by default
    handoff: vi.fn(async (input: { brief: string }) => `handoff from ${input.brief}`),
  };
}

function makeClassifier(verdict: 'covered' | 'proceed' | 'ask' = 'proceed'): DecisionClassifier {
  return {
    classify: vi.fn(async () => ({ verdict, reason: 'r', via: 'rule' as const })),
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
      answer: answer ?? Promise.resolve({ parkId: 'park1', text: 'yes go ahead', authorId: 'U1', ts: 'a1' }),
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
  return { visibility: { postSectionPlan } as unknown as PlanVisibilityService, postSectionPlan };
}

interface AutofixHandle {
  autofix: AutoFixStage;
  autofixSection: ReturnType<typeof vi.fn>;
  autofixPullRequest: ReturnType<typeof vi.fn>;
}
function makeAutofix(): AutofixHandle {
  const autofixSection = vi.fn(async () => cleanSummary('section'));
  const autofixPullRequest = vi.fn(async () => cleanSummary('pull_request'));
  return {
    autofix: { autofixSection, autofixPullRequest } as unknown as AutoFixStage,
    autofixSection,
    autofixPullRequest,
  };
}

function cleanSummary(mode: 'section' | 'pull_request') {
  return { mode, lensesRun: [], findings: [], fixesAttempted: false, fixReport: '', commits: [], clean: true };
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

function makeJob(overrides: Partial<Thread> = {}): Thread {
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
    threadId: 'job-abcdef12',
    status: 'approved',
    overview: 'Build the widget feature.',
    decisions: [],
    sectionBriefs: ['Backend', 'Frontend'],
    approvedBy: 'U1',
    approvedAt: new Date(),
  };
}

function makeSections(): DriverSection[] {
  return [
    section('sec-be', 10, 'Backend'),
    section('sec-fe', 20, 'Frontend'),
  ];
}

function section(id: string, ordinal: number, brief: string, status: SectionStatus = 'pending'): DriverSection {
  return {
    id,
    threadId: 'job-abcdef12',
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
function assemble(state: StoreState, opts: { classifierVerdict?: 'covered' | 'proceed' | 'ask'; parkAnswer?: Promise<ParkResolution>; env?: Record<string, string>; turn?: TurnRunnerService } = {}) {
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
  const env = { get: vi.fn((k: string) => opts.env?.[k]) } as unknown as EnvService;
  const driver = new SectionDriver(
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
    // local SANDBOX_PROVIDER: a no-op attach (host-local execution; no containerId).
    { attach: async ({ sandbox }) => sandbox, teardown: async () => undefined, teardownByIdentity: async () => undefined, contextDirHost: () => '/ctx' },
    // CredentialResolver: env-fallback shape (no tenant rows) — api_key auth, no token.
    {
      anthropicKey: async () => undefined,
      openaiKey: async () => undefined,
      githubToken: async () => undefined,
      engineAuth: async () => ({ secret: 'test-secret' }),
    } as unknown as CredentialResolver,
    // ThreadLifecycleService: no pre-provisioned sandbox → falls back to legacy per-feature path.
    {
      ensureContainer: async () => null,
      findSandbox: async () => null,
      recordPr: async () => undefined,
    } as unknown as import('./thread-lifecycle.service').ThreadLifecycleService,
    // BuildShipService: the real terminal "ship" over the same git/pr/autofix/store fakes, so the
    // PR-tail assertions (pushed/opened/setPrReady) hold exactly as before the extraction.
    new BuildShipService(autofix.autofix, git, pr, store),
    // PipelineAwarenessStore: append is a best-effort no-op (passive milestones not asserted here).
    { appendMarker: async () => undefined, drainAndAdvance: async () => ({ markers: [], stateChanged: false }) } as unknown as import('./pipeline-awareness.store').PipelineAwarenessStore,
  );
  return { driver, store, state, git, pr, turn, planner, classifier, ask, visibility, autofix, surface, pushed, commits, opened, calls, posts };
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('SectionDriver — the legible section/phase pipeline', () => {
  it('walks a 2-section / multi-phase job to ONE PR (plan → execute phases → autofix → handoff → next → PR-tail)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: makeSections(),
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // Both sections planned (one plan turn each) + each ran its 2 phases (execute turns).
    const planTurns = h.calls.filter((c) => c.mode === 'plan');
    const execTurns = h.calls.filter((c) => c.mode === 'execute');
    expect(planTurns).toHaveLength(2);
    expect(execTurns).toHaveLength(4); // 2 sections × 2 phases

    // Per-section auto-fix ran once per section; PR-tail ran exactly once.
    expect(h.autofix.autofixSection).toHaveBeenCalledTimes(2);
    expect(h.autofix.autofixPullRequest).toHaveBeenCalledTimes(1);

    // Both sections are done with a handoff; the SECOND section received the first's handoff.
    expect(state.sections.every((s) => s.status === 'done')).toBe(true);
    expect(state.sections[1].handoffIn).toBe('handoff from Backend');

    // ONE branch, ONE push, ONE PR — sections stacked on the same feature branch.
    expect(new Set(h.pushed).size).toBe(1);
    expect(h.opened).toHaveLength(1);
    expect(state.job.prUrl).toBe('https://github.com/acme/widget/pull/1');
    expect(state.job.status).toBe('done');
    expect(h.posts.some((p) => p.includes('PR ready'))).toBe(true);
  });

  it('every phase ran in the SAME feature branch (sections share one sandbox)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: makeSections(),
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The feature branch was set once and the worktree cut once per drive (idempotent reuse otherwise).
    expect(state.job.featureBranch).toBe('atlas/feature-job-abcd');
    const createCalls = (h.git.createFeatureSandbox as ReturnType<typeof vi.fn>).mock.calls;
    const branches = new Set(createCalls.map((c) => c[1]));
    expect(branches).toEqual(new Set(['atlas/feature-job-abcd']));
  });

  it('an uncovered always-ask decision PARKS the section and resumes on the human answer', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    // A human reply we resolve LATER — the section must suspend on `handle.answer` until then.
    let resolveAnswer!: (r: ParkResolution) => void;
    const answer = new Promise<ParkResolution>((res) => {
      resolveAnswer = res;
    });
    // The planner surfaces a notable decision; the classifier says ASK → the section parks.
    const h = assemble(state, { classifierVerdict: 'ask', parkAnswer: answer });
    (h.planner.extractDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { description: 'add a new users table' },
    ]);

    await h.driver.dispatch(state.job);
    await flush();

    // The section parked: ask was called, the section sits awaiting_approval, NO execute turn yet.
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(state.sections[0].status).toBe('awaiting_approval');
    expect(h.calls.some((c) => c.mode === 'execute')).toBe(false);

    // The human replies → the section unparks and runs to completion.
    resolveAnswer({ parkId: 'park1', text: 'yes, use a users table', authorId: 'U1', ts: 'a1' });
    await flushUntil(() => state.job.status === 'done');

    expect(h.calls.some((c) => c.mode === 'execute')).toBe(true);
    expect(state.sections[0].status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('persists resumable phase step-state (each phase ends done/done; session set during the turn)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    const phases = state.phases.filter((p) => p.sectionId === 'sec-be');
    expect(phases).toHaveLength(2);
    expect(phases.every((p) => p.status === 'done' && p.step === 'done')).toBe(true);
    // setPhaseState was driven to 'building' then 'done' for each phase (explicit, resumable cursor).
    expect((h.store.setPhaseState as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])).toEqual([
      'building',
      'done',
      'building',
      'done',
    ]);
  });

  it('resume() fast-forwards completed sections/phases after a simulated restart (no re-execution)', async () => {
    // Simulate a restart MID-JOB: section 1 (Backend) already done with a handoff + its phases done;
    // section 2 (Frontend) still pending, no phases yet. Same store rows, a FRESH driver.
    const doneBackend = section('sec-be', 10, 'Backend', 'done');
    doneBackend.handoffOut = 'handoff from Backend';
    const state: StoreState = {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      sections: [doneBackend, section('sec-fe', 20, 'Frontend')],
      phases: [
        { id: 'sec-be-ph0', sectionId: 'sec-be', threadId: 'job-abcdef12', ordinal: 10, title: 'A', brief: 'do A', step: 'done', status: 'done', sessionId: 's' },
        { id: 'sec-be-ph1', sectionId: 'sec-be', threadId: 'job-abcdef12', ordinal: 20, title: 'B', brief: 'do B', step: 'done', status: 'done', sessionId: 's' },
      ],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The done Backend section was NOT re-planned and NOT re-executed (no plan/exec turn for it).
    // Only the Frontend section planned (1 plan turn) + ran (2 exec turns).
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(1);
    expect(h.calls.filter((c) => c.mode === 'execute')).toHaveLength(2);
    // The Frontend section received Backend's persisted handoff.
    expect(state.sections[1].handoffIn).toBe('handoff from Backend');
    // Still ONE PR.
    expect(h.opened).toHaveLength(1);
    expect(state.job.status).toBe('done');
  });

  it('resume() re-runs an interrupted (executing) phase — reopens the current phase, idempotent commit', async () => {
    // A phase left mid-build by a crash: status 'building'. resume() should re-run it (status not done).
    const state: StoreState = {
      job: makeJob({ featureBranch: 'atlas/feature-job-abcd' }),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend', 'executing')],
      phases: [
        { id: 'sec-be-ph0', sectionId: 'sec-be', threadId: 'job-abcdef12', ordinal: 10, title: 'A', brief: 'do A', step: 'done', status: 'done', sessionId: 's' },
        { id: 'sec-be-ph1', sectionId: 'sec-be', threadId: 'job-abcdef12', ordinal: 20, title: 'B', brief: 'do B', step: 'build', status: 'building', sessionId: 's2' },
      ],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);

    await h.driver.resume();
    await flushUntil(() => state.job.status === 'done');

    // The already-locked phases skip planning; only the unfinished phase (B) re-runs.
    expect(h.calls.filter((c) => c.mode === 'plan')).toHaveLength(0); // phases already locked
    const execPhaseIds = h.calls.filter((c) => c.mode === 'execute').map((c) => c.phaseId);
    expect(execPhaseIds).toEqual(['sec-be-ph1']); // only the interrupted phase
    expect(state.phases.find((p) => p.id === 'sec-be-ph1')?.status).toBe('done');
    expect(state.job.status).toBe('done');
  });

  it('a clean stimulus (no always-ask) proceeds without parking — covered/proceed never blocks', async () => {
    const state: StoreState = {
      job: makeJob({ kind: 'bugfix' }),
      record: makeRecord(),
      sections: [section('sec-fix', 10, 'Fix the bug')],
      phases: [],
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
      sections: makeSections(),
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.posts.some((p) => p.includes('Starting the build'))).toBe(true);
    expect(h.posts.some((p) => p.includes('Planning section') && p.includes('Backend'))).toBe(true);
    expect(h.posts.some((p) => p.toLowerCase().includes('building'))).toBe(true);
    expect(h.posts.some((p) => p.includes('PR ready'))).toBe(true);
  });

  it('relays a clear "build failed — why" when a phase errors, never dead-ends silently (issue #2)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    // Plan turn succeeds; the execute turn explodes → must propagate to a failure relay.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (input: { mode: string }) => {
      if (input.mode === 'plan') return { report: 'plan', planText: 'PLAN', session: {} };
      throw new Error('engine exploded mid-phase');
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'failed');

    expect(state.job.status).toBe('failed');
    expect(h.posts.some((p) => p.includes('Build failed') && p.includes('engine exploded mid-phase'))).toBe(true);
    expect(h.opened).toHaveLength(0); // no PR opened on a failed build
  });

  it('aborts + relays a phase that exceeds PHASE_TIMEOUT_MS (issue #3 circuit breaker)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state, { env: { PHASE_TIMEOUT_MS: '20' } });
    // Plan resolves; the execute turn NEVER settles AND ignores the abort signal (mimics the real SDK
    // stuck in a non-yielding subprocess). The HARD race-timeout must still bound the driver.
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string }) => {
        if (input.mode === 'plan') return { report: 'plan', planText: 'PLAN', session: {} };
        return new Promise(() => {}); // never settles, never honors abort
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'failed');

    expect(state.job.status).toBe('failed');
    expect(h.posts.some((p) => p.includes('Build failed') && p.includes('PHASE_TIMEOUT_MS'))).toBe(true);
  });

  it('fails the phase when VERIFY_CMD exits non-zero, before any commit (issue #4)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state, { env: { VERIFY_CMD: 'exit 1' } });
    // The verify command runs in the worktree cwd — point it at a real existing dir so exec can spawn.
    (h.git.createFeatureSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      repoId: 'proj',
      branch: 'atlas/feature-job-abcd',
      worktreePath: tmpdir(),
      gitUrl: REPO.gitUrl,
      token: 'ghtok',
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'failed');

    expect(state.job.status).toBe('failed');
    expect(h.posts.some((p) => p.includes('Verification failed'))).toBe(true);
    // The phase failed at verification → nothing was committed for it.
    expect(h.commits).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  it('relays off-spec DEVIATION lines a phase flags in its report (issue #7)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (input: { mode: string; phaseId?: string | null }) => {
      if (input.mode === 'plan') return { report: 'plan', planText: 'PLAN', session: {} };
      return {
        report: 'Implemented the endpoint.\nDEVIATION: added a README nobody asked for.',
        session: { id: 's', jobId: 'j', phaseId: input.phaseId ?? null, engine: 'claude', mode: 'execute', branch: 'b', worktreePath: '/wt/b' },
      };
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    expect(h.posts.some((p) => p.includes('Off-spec') && p.includes('README nobody asked for'))).toBe(true);
    expect(state.job.status).toBe('done'); // a deviation is surfaced, not a failure
  });

  it('fails + relays a park that is never answered (PARK_TIMEOUT_MS) instead of hanging forever', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
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
    expect(h.posts.some((p) => p.includes('Build failed') && /waiting for your input/i.test(p))).toBe(true);
    expect(h.calls.some((c) => c.mode === 'execute')).toBe(false); // never got past the gate
    expect(h.opened).toHaveLength(0);
  });

  it('PAUSES the job (not failed) on an EngineAuthError and relays a pause notice (resume feature)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(async (input: { mode: string }) => {
      if (input.mode === 'plan') return { report: 'plan', planText: 'PLAN', session: {} };
      throw new EngineAuthError('401 invalid api key', 'sess-401');
    });

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'paused');

    expect(state.job.status).toBe('paused'); // paused, NOT failed
    expect(h.posts.some((p) => /paused/i.test(p) && /credential|auth/i.test(p))).toBe(true);
    expect(h.opened).toHaveLength(0);
  });

  it('resumePaused re-drives a paused job to completion; no-ops if the job is not paused', async () => {
    // no-op path: a non-paused job is left alone.
    const running: StoreState = {
      job: makeJob({ status: 'done' }),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend', 'done')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const noop = assemble(running);
    await noop.driver.resumePaused(running.job.id);
    expect(noop.opened).toHaveLength(0); // never re-driven

    // resume path: a paused job is flipped to running and driven to a PR.
    const state: StoreState = {
      job: makeJob({ status: 'paused' }),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state);
    await h.driver.resumePaused(state.job.id);
    await flushUntil(() => state.job.status === 'done');
    expect(state.job.status).toBe('done');
    expect(h.opened).toHaveLength(1);
  });

  it('bounds a runaway section PLAN turn — aborts + falls back to the planner, no hang (issue #3)', async () => {
    const state: StoreState = {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
      route: { channel: 'C1', threadTs: 't1' },
    };
    const h = assemble(state, { env: { PHASE_TIMEOUT_MS: '20' } });
    (h.turn.runTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: { mode: string; phaseId?: string | null }) => {
        // The plan turn NEVER settles and ignores abort (a runaway read-only exploration the SDK won't
        // interrupt). The hard race-timeout must bound it and fall back to the planner.
        if (input.mode === 'plan') return new Promise(() => {});
        return { report: `did ${input.phaseId}`, session: {} };
      },
    );

    await h.driver.dispatch(state.job);
    await flushUntil(() => state.job.status === 'done');

    // The plan turn timed out but the build did NOT hang: the structured planner supplied phases and
    // execution proceeded to completion (phases committed, one PR opened).
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

describe('SectionDriver — 401 auth recovery', () => {
  /** A turn that throws EngineAuthError on the FIRST execute (a mid-build 401), then succeeds. */
  function flakyAuthTurn(): TurnRunnerService {
    let executes = 0;
    return {
      runTurn: vi.fn(async (input: { mode: string; phaseId?: string | null; jobId: string }) => {
        if (input.mode === 'execute' && ++executes === 1) {
          throw new EngineAuthError('401 Invalid API key', 'sess-401');
        }
        return {
          report: input.mode === 'plan' ? 'plan' : `did ${input.phaseId}`,
          ...(input.mode === 'plan' ? { planText: 'P' } : {}),
          session: {
            id: 'sess-401',
            jobId: input.jobId,
            phaseId: input.phaseId ?? null,
            engine: 'claude' as const,
            mode: input.mode as 'plan' | 'execute' | 'review',
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      }),
    } as unknown as TurnRunnerService;
  }

  function freshState(): StoreState {
    return {
      job: makeJob(),
      record: makeRecord(),
      sections: [section('sec-be', 10, 'Backend')],
      phases: [],
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
