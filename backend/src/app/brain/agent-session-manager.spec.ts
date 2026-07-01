import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatStimulus } from '../domain';
import type { JobDispatcher } from './job-dispatcher';
import type { BrainStoreService } from './brain-store.service';
import type { DecisionApprovalService } from './decision-approval.service';
import type { DriverStoreService } from '../driver/driver-store.service';
import type { MemoryStore } from '../memory';
import type { JobLifecycleService } from '../driver/job-lifecycle.service';
import type { EngineRunnerPort } from '../engine/engine.types';
import type { BuildShipService } from '../driver/build-ship.service';
import { DecisionLedgerService } from './decision-ledger.service';
import type { RepoDecisionManifestService } from './repo-decision-manifest.service';
import type { DriverRepoResolver } from '../driver/repo-resolver';
import type { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import type { TicketService } from '../tickets';
import type { DecisionClassifier } from '../decision-gate';
import type { BlockSink, ChatSurface, LiveTurnStore } from '../surface';
import { TurnHarnessFactory } from '../surface';

/** A no-op transcript harness for tests that don't exercise streaming. */
const noopTurnHarness = {
  create: () => ({
    onEvent: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  }),
} as unknown as TurnHarnessFactory;
import type { Repository } from 'typeorm';
import type { JobSandboxEntity } from '../persistence/entities';
import { AgentSessionManager } from './agent-session-manager.service';
import { ProvisioningNotReadyError } from '../driver/job-lifecycle.service';
import { UNRESUMABLE_SESSION_MARKER } from '../engine/engine.types';
import type { EngineEvent, RunEngineArgs } from '../engine/engine.types';
import type { EventStimulus } from '../domain';
import { UNTRUSTED_OPEN } from '../stimulus';
import type { PlanReviewService } from './plan-review.service';
import type { TurnRecoveryService } from './turn-recovery.service';
import type { CredentialResolver, WorktreeSecretStore } from '../onboarding';

/**
 * R3 GATE TESTS — two assertions:
 *   (a) A chat turn's `submit_plan` tool call persists a detailed decision record + threads
 *       (offline-deterministic, fake bridge — drives `buildTools()` directly, no real engine).
 *   (b) An EVENT is delivered to the SAME thread brain as a harness message (`deliverEvent`) — there is
 *       no second triage brain; the seed turn carries the framed + UNTRUSTED-fenced body, then stamps
 *       `delivered_at` (at-least-once).
 */
describe('R3 gate: AgentSessionManager.buildTools() — submit_plan (offline, fake bridge)', () => {
  let manager: AgentSessionManager;

  /** Full mocked deps — only the methods exercised by submit_plan need an implementation. */
  const mockStore = {
    openJobOnThread: vi.fn(),
    openJob: vi.fn(),
    persistPlan: vi.fn(),
    route: vi.fn(),
    appendAtlasMessage: vi.fn(),
    appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn(),
    cancel: vi.fn(),
    reopenPlanning: vi.fn(),
    loadJob: vi.fn(),
    // Working-set decisions (create_decision / submit_plan source these); default to empty.
    pendingDecisions: vi.fn().mockResolvedValue([]),
    createDecision: vi.fn().mockResolvedValue({ decision: { id: 'd1' }, all: [{ id: 'd1' }] }),
    updateDecision: vi.fn().mockResolvedValue(null),
    deleteDecision: vi.fn().mockResolvedValue({ removed: false, all: [] }),
    appendCardMessage: vi.fn(),
    updateCardMessage: vi.fn(),
    latestAnsweredQuestionCard: vi.fn().mockResolvedValue(null),
    // Durable human-input gate (ask_question lifecycle); default to "no question open".
    openQuestion: vi.fn().mockResolvedValue({ ok: true }),
    awaitingQuestionId: vi.fn().mockResolvedValue(null),
    getQuestionCard: vi.fn().mockResolvedValue(null),
    markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
    clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
    findUndeliveredAnsweredQuestions: vi.fn().mockResolvedValue([]),
    // Secure secret-request gate (request_secret lifecycle); default to "no request open".
    openSecretRequest: vi.fn().mockResolvedValue({ ok: true }),
    awaitingSecretId: vi.fn().mockResolvedValue(null),
    getSecretCard: vi.fn().mockResolvedValue(null),
    markSecretProvided: vi.fn().mockResolvedValue(undefined),
    markSecretDelivered: vi.fn().mockResolvedValue(undefined),
    clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
    findUndeliveredProvidedSecrets: vi.fn().mockResolvedValue([]),
    // R4 async plan-review seam.
    appendSystemEvent: vi.fn().mockResolvedValue(undefined),
    markAwaitingApproval: vi.fn().mockResolvedValue(undefined),
    loadDecisionRecord: vi.fn(),
    appendReviewFindingsMessage: vi.fn().mockResolvedValue(true),
    threadTicketId: vi.fn().mockResolvedValue(null),
    // The "needs you" turn-active flag is best-effort; the manager brackets every chat turn with it.
    setTurnActive: vi.fn().mockResolvedValue(undefined),
    resetAllTurnActive: vi.fn().mockResolvedValue(0),
  } as unknown as BrainStoreService;

  const mockDriverStore = {
    getPipelineState: vi.fn(),
    getDecisionRecord: vi.fn(),
  } as unknown as DriverStoreService;

  const mockMemory = {
    recall: vi.fn(),
    remember: vi.fn(),
  } as unknown as MemoryStore;

  const mockApprovals = {
    request: vi.fn(),
  } as unknown as DecisionApprovalService;

  const mockLifecycle = {
    findSandbox: vi.fn(),
    contextDirHost: vi.fn(),
  } as unknown as JobLifecycleService;

  const mockDockerRunner = {} as unknown as EngineRunnerPort;

  // Fast-path deps: classify (default → proceed), ship, repo resolve.
  const mockClassifier = {
    classify: vi.fn().mockResolvedValue({ verdict: 'proceed', reason: '', via: 'rule' }),
  } as unknown as DecisionClassifier;

  const mockShip = {
    ship: vi.fn().mockResolvedValue({ url: 'https://gh/pr/1', number: 1, existing: false }),
  } as unknown as BuildShipService;

  const mockRepos = {
    resolve: vi.fn().mockResolvedValue({ owner: 'o', repo: 'r', defaultBranch: 'main', token: 't' }),
  } as unknown as DriverRepoResolver;

  // Passive pipeline-awareness buffer — append is a no-op; drain conveys nothing in these unit tests.
  const mockAwareness = {
    appendMarker: vi.fn().mockResolvedValue(undefined),
    drainAndAdvance: vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
  } as unknown as PipelineAwarenessStore;

  /**
   * R4: mock async PlanReviewService. `start` opens a round; `load` returns null by default so the
   * fire-and-forget `runAndDeliverReview` no-ops cleanly in these submit_plan unit tests (the full
   * run→deliver flow is exercised in the integration spec). `maxReviewRounds` is a plain property.
   */
  const mockPlanReview = {
    start: vi.fn().mockResolvedValue({ reviewId: 'rev-r3gate-001', round: 1 }),
    runReview: vi.fn().mockResolvedValue({ status: 'complete', findings: '' }),
    load: vi.fn().mockResolvedValue(null),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    findIncompleteReviews: vi.fn().mockResolvedValue([]),
    findUndeliveredReviews: vi.fn().mockResolvedValue([]),
    // The finalize_plan gate: default = no round running (the review finished), so finalize is allowed.
    runningReview: vi.fn().mockResolvedValue(null),
    maxReviewRounds: 3,
  } as unknown as PlanReviewService;

  const mockDispatcher = {
    dispatch: vi.fn(),
  } as unknown as JobDispatcher;

  const mockSurface = {
    post: vi.fn(),
    name: 'agent',
    emitThreadMeta: vi.fn(),
  } as unknown as ChatSurface;

  const mockSandboxRows = {
    findOne: vi.fn(),
    save: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as Repository<JobSandboxEntity>;


  const TEAM_ID = 'T-R3GATE';
  const PROJECT_ID = 'r3gate-proj';
  const THREAD_ID = 'th-r3gate-001';

  const fakeStimulus: ChatStimulus = {
    kind: 'chat',
    trust: 'trusted',
    id: 'stim-r3gate-001',
    receivedAt: new Date('2026-06-21T00:00:00Z'),
    orgId: TEAM_ID,
    repoId: PROJECT_ID,
    jobId: THREAD_ID,
    body: 'Add rate limiting to the API',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'agent', threadRef: 'ts-r3gate-001' },
  };

  const FAKE_JOB_ID = 'job-r3gate-001';
  const FAKE_RECORD_ID = 'rec-r3gate-001';

  beforeEach(() => {
    vi.resetAllMocks();

    // Default classifier verdict: proceed (fast path allowed unless a test overrides it).
    (mockClassifier.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      verdict: 'proceed',
      reason: '',
      via: 'rule',
    });

    // Passive-awareness defaults (resetAllMocks wiped the resolved values) — append is a no-op promise.
    (mockAwareness.appendMarker as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockAwareness.drainAndAdvance as ReturnType<typeof vi.fn>).mockResolvedValue({
      markers: [],
      stateChanged: false,
    });

    // By default: no existing open job on the thread → openJob creates a fresh one.
    (mockStore.openJobOnThread as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.openJob as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_JOB_ID);

    // Working-set decisions default to empty; card lookups default to none (reset wiped inline defaults).
    (mockStore.pendingDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.deleteDecision as ReturnType<typeof vi.fn>).mockResolvedValue({ removed: false, all: [] });
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Human-input gate defaults: opening succeeds, no question currently open.
    (mockStore.openQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (mockStore.awaitingQuestionId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.markQuestionDelivered as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.clearAwaitingQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockLifecycle.contextDirHost as ReturnType<typeof vi.fn>).mockReturnValue('/tmp/atlas-test-ctx');

    // R4 plan-review defaults (resetAllMocks wiped resolved values). appendSystemEvent MUST resolve a
    // promise — submit_plan chains `.catch` on it.
    (mockStore.appendSystemEvent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.markAwaitingApproval as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.appendReviewFindingsMessage as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockStore.threadTicketId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockPlanReview.start as ReturnType<typeof vi.fn>).mockResolvedValue({ reviewId: 'rev-r3gate-001', round: 1 });
    (mockPlanReview.runReview as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'complete', findings: '' });
    (mockPlanReview.load as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockPlanReview.markDelivered as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockPlanReview.findIncompleteReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockPlanReview.findUndeliveredReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // persistPlan returns the canonical shape BrainStoreService returns.
    (mockStore.persistPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      thread: {
        id: FAKE_JOB_ID,
        status: 'awaiting_approval',
        title: 'Add rate limiting to the API',
        kind: 'feature',
        org_id: TEAM_ID,
        repo_id: PROJECT_ID,
        job_id: THREAD_ID,
        decision_record_id: FAKE_RECORD_ID,
        created_at: new Date(),
        updated_at: new Date(),
        pr_url: null,
      },
      decisionRecordId: FAKE_RECORD_ID,
    });

    // route() returns the channel/thread so the approval card can be posted.
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({
      channel: 'C-R3GATE',
      threadTs: 'ts-r3gate-001',
    });
    (mockStore.appendAtlasMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Approval request returns a handle whose verdict never resolves (we don't await approval here).
    const neverResolves = new Promise(() => undefined);
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: neverResolves,
    });

    manager = new AgentSessionManager(
      mockStore,
      mockDriverStore,
      mockMemory,
      mockApprovals,
      mockLifecycle,
      mockDockerRunner,
      { listRunning: async () => [] } as never, // turnRegistry
      mockPlanReview,
      mockDispatcher,
      mockSurface,
      mockSandboxRows,
      { findOne: async () => null, update: async () => undefined, find: async () => [] } as never, // stimulusRows
      noopTurnHarness,
      mockClassifier,
      mockShip,
      mockRepos,
      mockAwareness,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      new DecisionLedgerService(),
      {
        recordPromoted: async () => undefined,
        reconcileFromBaseCheckout: async () => ({ reconciled: 0, accepted: 0, flagged: 0 }),
        reposWithGit: async () => [],
      } as unknown as RepoDecisionManifestService,
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        grant: async () => undefined,
        listGrants: async () => [],
        read: async () => null,
      } as unknown as WorktreeSecretStore,
    );
  });

  it('(a) submit_plan: persists overview + decisions + structured threads-with-steps + goal as title', async () => {
    const tools = manager.buildTools(fakeStimulus);

    const goal = 'Add rate limiting to the public API';
    const overview = 'Add token-bucket rate limiting to the public API endpoints.';
    const decisions = [
      {
        decisionClass: 'infrastructure',
        title: 'Rate-limit backend',
        ruling: 'Use a Redis token bucket (per-IP, 100 req/min) via the existing RedisService.',
      },
      {
        decisionClass: 'api_contract',
        title: '429 response shape',
        ruling: "Return { error: 'rate_limited', retryAfterSeconds: N } with a Retry-After header.",
      },
    ];
    // Each track carries its authored steps (title + keystroke-level brief).
    const threads = [
      {
        title: 'RateLimiter guard',
        steps: [
          { title: 'Add the guard', brief: 'Create RateLimiterGuard in src/guards/rate-limiter.guard.ts:1 …' },
          { title: 'Wire it in', brief: 'Register the guard in app.module.ts:42 …' },
        ],
      },
      {
        title: 'Integration tests',
        steps: [{ title: 'Cover 429s', brief: 'Add rate-limit.int.test.ts asserting the 429 shape …' }],
      },
    ];

    const result = await tools['submit_plan']({ goal, overview, decisions, threads });

    // 1. persistPlan gets the track titles AND the per-track authored steps + title=goal, and persists
    //    as `plan_review` (NOT awaiting_approval — submit_plan requests a review, it does not post a card).
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.overview).toBe(overview);
    expect(persistArgs.decisions).toHaveLength(2);
    expect(persistArgs.title).toBe(goal);
    expect(persistArgs.threadTitles).toEqual(['RateLimiter guard', 'Integration tests']);
    expect(persistArgs.stepsByThread).toHaveLength(2);
    expect(persistArgs.stepsByThread[0]).toHaveLength(2);
    expect(persistArgs.stepsByThread[0][0]).toMatchObject({ title: 'Add the guard' });
    expect(persistArgs.stepsByThread[1]).toHaveLength(1);
    expect(persistArgs.orgId).toBe(TEAM_ID);
    expect(persistArgs.repoId).toBe(PROJECT_ID);
    expect(persistArgs.status).toBe('plan_review');

    // 2. The tool returns ok=true + the ids + the review round; an async Codex review was kicked.
    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID, decisionRecordId: FAKE_RECORD_ID, reviewRound: 1 });
    expect(mockPlanReview.start).toHaveBeenCalledOnce();
    const reviewArgs = (mockPlanReview.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(reviewArgs.jobId).toBe(FAKE_JOB_ID);
    expect(reviewArgs.threadTitles).toEqual(['RateLimiter guard', 'Integration tests']);

    // 3. submit_plan does NOT post the approval card (that is finalize_plan's job). It repaints the
    //    title and drops a "reviewing" system-event pill.
    const persistedTitle = 'Add rate limiting to the API'; // what the persistPlan mock returns as job.title
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).not.toHaveBeenCalled();
    expect(mockStore.appendSystemEvent).toHaveBeenCalledOnce();
    expect(mockSurface.emitThreadMeta).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID, persistedTitle);
  });

  it('finalize_plan: posts the approval card from the persisted (plan_review) plan', async () => {
    const tools = manager.buildTools(fakeStimulus);

    // The thread is in plan_review with a locked decision record (submit_plan ran earlier).
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'plan_review',
      title: 'Add rate limiting to the API',
      decisionRecordId: FAKE_RECORD_ID,
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'Add token-bucket rate limiting.',
      decisions: [{ decisionClass: 'infrastructure', title: 'Backend', ruling: 'Redis bucket' }],
      threadTitles: ['RateLimiter guard', 'Integration tests'],
    });

    const result = await tools['finalize_plan']({});

    // Flips to the operator gate, then posts the approval card async with the persisted title + threads.
    expect(mockStore.markAwaitingApproval).toHaveBeenCalledWith(FAKE_JOB_ID);
    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    const approvalArgs = (mockApprovals.request as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(approvalArgs.title).toBe('Add rate limiting to the API');
    expect(approvalArgs.threads).toEqual(['RateLimiter guard', 'Integration tests']);
    expect(approvalArgs.summary).toBe('Add token-bucket rate limiting.');
  });

  it('finalize_plan: refuses when there is no submitted plan', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'planning',
      decisionRecordId: null,
    });
    const result = await tools['finalize_plan']({});
    expect(result).toMatchObject({ ok: false });
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('finalize_plan: refuses (no card) while a Codex review round is still running', async () => {
    const tools = manager.buildTools(fakeStimulus);
    // The thread is in plan_review with a locked record, but the background Codex review has not finished.
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'plan_review',
      title: 'Add rate limiting to the API',
      decisionRecordId: FAKE_RECORD_ID,
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });
    (mockPlanReview.runningReview as ReturnType<typeof vi.fn>).mockResolvedValue({ round: 2 });

    const result = await tools['finalize_plan']({});

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('still running');
    // The gate fires BEFORE the approval card is posted (the review must finish first).
    expect(mockStore.markAwaitingApproval).not.toHaveBeenCalled();
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error (no persist) if goal is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      overview: 'some overview',
      threads: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: step-free threads persist (steps optional → driver JIT-plans)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      overview: 'some overview',
      threads: [{ title: 'S', type: 'backend' }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.threadTitles).toEqual(['S']);
    expect(persistArgs.threadTypes).toEqual(['backend']);
    // No authored steps → `stepsByThread` omitted so persistPlan leaves the driver to JIT-plan the track.
    expect(persistArgs.stepsByThread).toBeUndefined();
  });

  it('(a) submit_plan: returns error if overview is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      threads: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error if threads are missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      overview: 'some overview',
      decisions: [],
      threads: [],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(c) start_direct_build: classifier proceed → minimal record + lightweight (direct) approval card', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['start_direct_build']({
      summary: 'Fix the off-by-one in the pagination cursor',
      changeOutline: ['adjust the slice bound in paginate()'],
    });

    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
    // Minimal record: no threads.
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.threadTitles).toEqual([]);
    expect(persistArgs.overview).toContain('off-by-one');

    // The card is the lightweight 'direct' variant carrying the change outline.
    await new Promise((r) => setTimeout(r, 0));
    const approvalArgs = (mockApprovals.request as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(approvalArgs.kind).toBe('direct');
    expect(approvalArgs.threads).toEqual(['adjust the slice bound in paginate()']);
  });

  it('(c) start_direct_build: classifier ASK (uncovered always-ask) → refused, no persist', async () => {
    (mockClassifier.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      verdict: 'ask',
      decisionClass: 'data_model',
      reason: 'adds a column',
      via: 'rule',
    });
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['start_direct_build']({ summary: 'Add a deleted_at column to users' });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('always-ask');
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('(e) ask_question opens the durable gate with a normalized question_card', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['ask_question']({
      question: 'Where does the customer pick the subdomain?',
      decisionClass: 'data_model',
      options: ['Auto-default at provision', { label: 'Pick in the wizard', description: 'first-run UX' }],
    });

    expect(result).toMatchObject({ ok: true });
    // ask_question opens the gate ATOMICALLY (card row + awaiting pointer in one tx), not a bare append.
    expect(mockStore.openQuestion).toHaveBeenCalledOnce();
    const call = (mockStore.openQuestion as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(THREAD_ID);
    const card = call[1].card;
    expect(card).toMatchObject({ type: 'question_card', decisionClass: 'data_model', allowOther: true });
    expect(card.options).toHaveLength(2);
    expect(card.options[0]).toMatchObject({ label: 'Auto-default at provision' });
    expect(card.options[0].id).toBeTruthy();
  });

  it('(e2) ask_question allows stacking — a second open question is NOT refused', async () => {
    // openQuestion no longer refuses while one is open; the brain may have several cards open at once.
    (mockStore.openQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['ask_question']({ question: 'Another one?', options: [] });
    expect(result).toMatchObject({ ok: true });
    expect((result as { questionId: string }).questionId).toBeTruthy();
  });

  it('(f) create_decision attaches the most-recently-answered question and returns the resolved decision + id', async () => {
    // With no explicit questionId / delivery seedQuestionId, create_decision falls back to the newest
    // answered, not-yet-logged card (ordered by answeredAt) — its `ts` is the card it stamps consumed.
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: 'q-123',
      card: {
        type: 'question_card',
        question: 'Editable or fixed after checkout?',
        answer: 'Editable in the Network tab',
      },
    });
    const resolved = {
      id: 'd1',
      decisionClass: 'data_model',
      title: 'Editable or fixed after checkout?',
      ruling: 'Subdomain is editable; rename reconciles DNS.',
      question: 'Editable or fixed after checkout?',
      answer: 'Editable in the Network tab',
    };
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: resolved,
      all: [resolved],
    });

    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['create_decision']({
      decisionClass: 'data_model',
      ruling: 'Subdomain is editable; rename reconciles DNS.',
    });

    // The return carries the FULLY-RESOLVED decision (id + auto-attached Q&A) so the brain need not read back.
    expect(result).toMatchObject({ ok: true, total: 1, decision: resolved });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input).toMatchObject({
      decisionClass: 'data_model',
      ruling: 'Subdomain is editable; rename reconciles DNS.',
      question: 'Editable or fixed after checkout?',
      answer: 'Editable in the Network tab',
    });
    // The consumed card is flagged so the same Q&A can't attach to a second decision.
    expect(mockStore.updateCardMessage).toHaveBeenCalledWith(THREAD_ID, 'q-123', { loggedDecision: true });
  });

  it('(f1a) create_decision marks confirmedByOperator true ONLY with an attached answer', async () => {
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: 'q-1',
      card: { type: 'question_card', question: 'A or B?', answer: 'A' },
    });
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1', confirmedByOperator: true }],
    });
    const tools = manager.buildTools(fakeStimulus);
    await tools['create_decision']({ decisionClass: 'data_model', ruling: 'x', confirmedByOperator: true });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input.confirmedByOperator).toBe(true);
  });

  it('(f1b) create_decision coerces confirmedByOperator to false when no answer is attached', async () => {
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1', confirmedByOperator: false }],
    });
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['create_decision']({
      decisionClass: 'data_model',
      ruling: 'x',
      confirmedByOperator: true, // claimed, but no answer on record → coerced false
    });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input.confirmedByOperator).toBe(false);
    // The result echoes the running provenance balance.
    expect(result).toMatchObject({ provenance: { confirmed: 0, authored: 1 } });
  });

  it('(f1c) create_decision defaults confirmedByOperator to false (authored) when the arg is omitted', async () => {
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: 'q-1',
      card: { type: 'question_card', question: 'A or B?', answer: 'A' },
    });
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    const tools = manager.buildTools(fakeStimulus);
    await tools['create_decision']({ decisionClass: 'data_model', ruling: 'x' });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input.confirmedByOperator).toBe(false);
  });

  it('(f1d) update_decision promotes to confirmed only with evidence; demotion always allowed', async () => {
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    const tools = manager.buildTools(fakeStimulus);

    // Promote with an answer attached → true.
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: 'q-1',
      card: { type: 'question_card', question: 'A or B?', answer: 'A' },
    });
    await tools['update_decision']({ id: 'd1', confirmedByOperator: true });
    expect((mockStore.updateDecision as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toMatchObject({
      confirmedByOperator: true,
    });

    // Promote with NO answer → coerced false.
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await tools['update_decision']({ id: 'd1', confirmedByOperator: true });
    expect((mockStore.updateDecision as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toMatchObject({
      confirmedByOperator: false,
    });

    // Explicit demotion is always allowed.
    await tools['update_decision']({ id: 'd1', confirmedByOperator: false });
    expect((mockStore.updateDecision as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]).toMatchObject({
      confirmedByOperator: false,
    });
  });

  it('(f1e) create_decision attaches the EXPLICIT questionId card, not the newest-answered fallback', async () => {
    // With several questions answered, an explicit questionId pins exactly which one the decision settles.
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, id: string) =>
        id === 'q-explicit'
          ? { type: 'question_card', question: 'Which DB?', answer: 'Postgres' }
          : null,
    );
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      ts: 'q-other',
      card: { type: 'question_card', question: 'Other?', answer: 'wrong-one' },
    });
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    const tools = manager.buildTools(fakeStimulus);
    await tools['create_decision']({
      decisionClass: 'data_model',
      ruling: 'use postgres',
      questionId: 'q-explicit',
    });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input).toMatchObject({ question: 'Which DB?', answer: 'Postgres' });
    // The explicit card (not the fallback) is the one flagged consumed.
    expect(mockStore.updateCardMessage).toHaveBeenCalledWith(THREAD_ID, 'q-explicit', {
      loggedDecision: true,
    });
  });

  it('(f1f) create_decision on a DELIVERY turn attaches the seedQuestionId card', async () => {
    // The answer-delivery turn carries seedQuestionId; create_decision attaches that exact card.
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockImplementation(
      async (_t: string, id: string) =>
        id === 'q-delivered'
          ? { type: 'question_card', question: 'Routing?', answer: 'dynamic' }
          : null,
    );
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    const deliveryStimulus: ChatStimulus = { ...fakeStimulus, seed: true, seedQuestionId: 'q-delivered' };
    const tools = manager.buildTools(deliveryStimulus);
    await tools['create_decision']({ decisionClass: 'data_model', ruling: 'dynamic routing' });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input).toMatchObject({ question: 'Routing?', answer: 'dynamic' });
    expect(mockStore.updateCardMessage).toHaveBeenCalledWith(THREAD_ID, 'q-delivered', {
      loggedDecision: true,
    });
  });

  it('(g) create_decision rejects an invalid decisionClass', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['create_decision']({ decisionClass: 'nonsense', ruling: 'x' });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.createDecision).not.toHaveBeenCalled();
  });

  it('(g1b) create_decision normalizes a hyphenated/cased decisionClass to the canonical id', async () => {
    // The model often guesses `api-contract` before self-correcting; asDecisionClass normalizes it.
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['create_decision']({ decisionClass: 'API-Contract', ruling: 'x' });
    expect(result).toMatchObject({ ok: true });
    const input = (mockStore.createDecision as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input.decisionClass).toBe('api_contract');
  });

  it('(g1c) update_decision normalizes a hyphenated decisionClass', async () => {
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1', decisionClass: 'data_model' },
      all: [{ id: 'd1', decisionClass: 'data_model' }],
    });
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['update_decision']({ id: 'd1', decisionClass: 'data-model' });
    expect(result).toMatchObject({ ok: true });
    expect(mockStore.updateDecision).toHaveBeenCalledWith(THREAD_ID, 'd1', { decisionClass: 'data_model' });
  });

  it('(g1d) create_decision with no args returns the `args` envelope hint, not a field error', async () => {
    // When the model omits the bridge `args` wrapper the host receives {}; the error must point at the
    // envelope, not mislead with "decisionClass must be one of…".
    const tools = manager.buildTools(fakeStimulus);
    const result = (await tools['create_decision']({})) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/args/);
    expect(result.reason).not.toMatch(/must be one of/);
    expect(mockStore.createDecision).not.toHaveBeenCalled();
  });

  it('(g2) update_decision revises by id and returns the updated decision', async () => {
    const updated = { id: 'd2', decisionClass: 'api_contract', title: 'Pagination', ruling: 'Cursor-based.' };
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: updated,
      all: [updated],
    });

    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['update_decision']({ id: 'd2', ruling: 'Cursor-based.' });

    expect(result).toMatchObject({ ok: true, decision: updated });
    expect(mockStore.updateDecision).toHaveBeenCalledWith(THREAD_ID, 'd2', { ruling: 'Cursor-based.' });
  });

  it('(g3) update_decision on an unknown id returns knownIds without a separate read', async () => {
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.pendingDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);

    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['update_decision']({ id: 'd9', ruling: 'x' });

    expect(result).toMatchObject({ ok: false, knownIds: ['d1', 'd2'] });
  });

  it('(g4) update_decision rejects an invalid decisionClass before touching the store', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['update_decision']({ id: 'd1', decisionClass: 'nonsense' });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.updateDecision).not.toHaveBeenCalled();
  });

  it('(g5) delete_decision removes by id and returns the remaining ids', async () => {
    (mockStore.deleteDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      removed: true,
      all: [{ id: 'd1' }],
    });

    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['delete_decision']({ id: 'd2' });

    expect(result).toMatchObject({ ok: true, removed: 'd2', remainingIds: ['d1'] });
    expect(mockStore.deleteDecision).toHaveBeenCalledWith(THREAD_ID, 'd2');
  });

  it('(g6) delete_decision on an unknown id returns knownIds', async () => {
    (mockStore.deleteDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      removed: false,
      all: [{ id: 'd1' }],
    });

    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['delete_decision']({ id: 'd9' });

    expect(result).toMatchObject({ ok: false, knownIds: ['d1'] });
  });

  it('(d) approve buffers PASSIVE "approved" + "dispatched" milestones (no brain turn) after the durable approve/dispatch', async () => {
    const runningJob = { id: FAKE_JOB_ID, kind: 'feature', title: 'rate limiting' };
    (mockStore.approve as ReturnType<typeof vi.fn>).mockResolvedValue(runningJob);
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: Promise.resolve({ verdict: 'approve', ruledBy: 'U-OP' }),
    });

    await manager.requestApprovalAndAct(
      fakeStimulus,
      runningJob as never,
      FAKE_RECORD_ID,
      { jobId: FAKE_JOB_ID, decisionRecordId: FAKE_RECORD_ID, title: 'rate limiting', summary: 'x', decisions: [], threads: [] } as never,
    );

    // The build was dispatched (the durable action) — and the milestones were buffered AFTER it, not pushed.
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(runningJob);
    const markerIds = (mockAwareness.appendMarker as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[1] as { id: string }).id,
    );
    expect(markerIds).toContain(`approved:${FAKE_RECORD_ID}`);
    expect(markerIds).toContain(`dispatched:${FAKE_RECORD_ID}`);
  });

  it('(d2) resolveApprovalDurably: restart-safe approve (no live handle) dispatches the full build from durable state', async () => {
    const awaitingJob = {
      id: FAKE_JOB_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      status: 'awaiting_approval',
      decisionRecordId: FAKE_RECORD_ID,
      kind: 'feature',
      title: 'rate limiting',
    };
    const runningJob = { ...awaitingJob, status: 'running' };
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingJob);
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'x',
      decisions: [],
      threadTitles: ['Backend'], // non-empty ⇒ full plan ⇒ dispatch (not direct)
    });
    (mockStore.approve as ReturnType<typeof vi.fn>).mockResolvedValue(runningJob);
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });

    const acted = await manager.resolveApprovalDurably(FAKE_JOB_ID, 'approve', 'U-OP');

    expect(acted).toBe(true);
    expect(mockStore.approve).toHaveBeenCalledWith(FAKE_JOB_ID, FAKE_RECORD_ID, 'U-OP');
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(runningJob);
  });

  it('(d3) resolveApprovalDurably: no-op (returns false) when the job is no longer awaiting_approval', async () => {
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      status: 'running', // already handled by the live path / a prior click
      decisionRecordId: FAKE_RECORD_ID,
    });

    const acted = await manager.resolveApprovalDurably(FAKE_JOB_ID, 'approve', 'U-OP');

    expect(acted).toBe(false);
    expect(mockStore.approve).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe('AgentSessionManager.handleChatTurn — provisioning + live streaming/persistence', () => {
  const TEAM_ID = 'T-STREAM';
  const PROJECT_ID = 'stream-proj';
  const THREAD_ID = 'th-stream-001';

  const stimulus: ChatStimulus = {
    kind: 'chat',
    trust: 'trusted',
    id: 'stim-stream-001',
    receivedAt: new Date('2026-06-24T00:00:00Z'),
    orgId: TEAM_ID,
    repoId: PROJECT_ID,
    jobId: THREAD_ID,
    body: 'Explain the build step',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', threadRef: 'ts-stream-001' },
  };

  function makeManager(opts: {
    findSandbox?: unknown;
    ensureProvisioned?: ReturnType<typeof vi.fn>;
    run?: ReturnType<typeof vi.fn>;
    drainAndAdvance?: ReturnType<typeof vi.fn>;
    pendingCard?: unknown;
  }) {
    const store = {
      route: vi.fn().mockResolvedValue({ channel: PROJECT_ID, threadTs: THREAD_ID }),
      appendBlock: vi.fn().mockResolvedValue(undefined),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
      updateCardMessage: vi.fn().mockResolvedValue(undefined),
      loadJob: vi.fn().mockResolvedValue({ kind: null }),
      awaitingQuestionId: vi.fn().mockResolvedValue(null),
      // `pendingCard` simulates an open `ask_question` card (the live "currently-open card" reader).
      getQuestionCard: vi.fn().mockResolvedValue(opts.pendingCard ?? null),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
      awaitingSecretId: vi.fn().mockResolvedValue(null),
      getSecretCard: vi.fn().mockResolvedValue(null),
      markSecretDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
      setTurnActive: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrainStoreService;
    const lifecycle = {
      findSandbox: vi.fn().mockResolvedValue(opts.findSandbox ?? null),
      ensureProvisioned:
        opts.ensureProvisioned ?? vi.fn().mockResolvedValue({ id: 'sb-1', lifecycle: 'attached' }),
      ensureContainer: vi
        .fn()
        .mockResolvedValue({ sandbox: { worktreePath: '/wt', containerId: 'c1' }, wasReset: false }),
    } as unknown as JobLifecycleService;
    const surface = {
      post: vi.fn().mockResolvedValue('ts'),
      name: 'web',
    } as unknown as ChatSurface;
    const sandboxRows = {
      findOne: vi.fn().mockResolvedValue({ job_id: THREAD_ID, org_id: TEAM_ID, session_id: null }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as Repository<JobSandboxEntity>;
    const dockerRunner = { run: opts.run ?? vi.fn().mockResolvedValue({ result: '', sessionId: 's' }) } as unknown as EngineRunnerPort;
    const liveTurns = { push: vi.fn(), end: vi.fn() } as unknown as LiveTurnStore;
    // A REAL harness over the mock liveTurns + a mock durable sink — so the streaming spine is exercised
    // end-to-end through the brain (push/end + the durable blocks) exactly as in production.
    const blockSink = { appendBlock: vi.fn().mockResolvedValue(undefined) } as unknown as BlockSink;
    const turnHarness = new TurnHarnessFactory(liveTurns, blockSink);
    const driverStore = {
      getPipelineState: vi.fn().mockResolvedValue({ status: 'no_job' }),
    } as unknown as DriverStoreService;
    const awareness = {
      appendMarker: vi.fn().mockResolvedValue(undefined),
      drainAndAdvance:
        opts.drainAndAdvance ?? vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
    } as unknown as PipelineAwarenessStore;

    const manager = new AgentSessionManager(
      store,
      driverStore,
      {} as unknown as MemoryStore,
      {} as unknown as DecisionApprovalService,
      lifecycle,
      dockerRunner,
      { listRunning: async () => [] } as never, // turnRegistry
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      surface,
      sandboxRows,
      { findOne: async () => null, update: async () => undefined, find: async () => [] } as never, // stimulusRows
      turnHarness,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      awareness,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      new DecisionLedgerService(),
      {
        recordPromoted: async () => undefined,
        reconcileFromBaseCheckout: async () => ({ reconciled: 0, accepted: 0, flagged: 0 }),
        reposWithGit: async () => [],
      } as unknown as RepoDecisionManifestService,
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        grant: async () => undefined,
        listGrants: async () => [],
        read: async () => null,
      } as unknown as WorktreeSecretStore,
    );
    return { manager, store, lifecycle, surface, sandboxRows, dockerRunner, liveTurns, blockSink, awareness };
  }

  it('streams every engine event live AND persists authoritative blocks (text/thinking/tool), no duplicate final reply', async () => {
    const run = vi.fn(async (args: RunEngineArgs) => {
      args.onEvent?.({ kind: 'session', sessionId: 'sess-1' });
      args.onEvent?.({ kind: 'thinking', text: 'reasoning…' });
      args.onEvent?.({ kind: 'text', text: 'Hello' });
      args.onEvent?.({ kind: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'README.md' } });
      args.onEvent?.({ kind: 'tool_result', id: 'tu1', result: 'file contents', isError: false });
      args.onEvent?.({ kind: 'text', text: 'Done.' });
      args.onEvent?.({ kind: 'result', text: 'Done.' });
      return { result: 'Done.', sessionId: 'sess-1' };
    });
    const { manager, store, surface, liveTurns, blockSink, dockerRunner } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    // richStream is requested for the brain turn.
    const runArgs = (dockerRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
    expect(runArgs.richStream).toBe(true);

    // Every engine event was pushed LIVE into the resumable store (on the default `main` lane), then the
    // turn was ended (turn_end).
    const pushed = (liveTurns.push as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[2] as EngineEvent).kind,
    );
    expect(pushed).toEqual(['session', 'thinking', 'text', 'tool_use', 'tool_result', 'text', 'result']);
    expect((liveTurns.push as ReturnType<typeof vi.fn>).mock.calls.every((c) => (c[3] ?? 'main') === 'main')).toBe(true);
    expect(liveTurns.end as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    // The authoritative blocks were persisted via the durable sink: thinking, two text (chat) blocks, and
    // one paired tool call.
    const blocks = (blockSink.appendBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(blocks).toContainEqual(expect.objectContaining({ kind: 'thinking', text: 'reasoning…' }));
    expect(blocks.filter((b) => b.kind === 'chat').map((b) => b.text)).toEqual(['Hello', 'Done.']);
    const toolBlock = blocks.find((b) => b.kind === 'tool');
    expect(toolBlock?.meta).toMatchObject({ name: 'Read', result: 'file contents', isError: false });
    expect(toolBlock?.meta?.input).toMatchObject({ path: 'README.md' });

    // Each block is stamped with its strictly-increasing EMISSION time (not the turn-end time) so a
    // follow-up the operator sends mid-turn orders chronologically instead of jumping above the turn.
    const stamps = blocks.map((b) => (b.createdAt as Date).getTime());
    expect(stamps.every((t) => typeof t === 'number')).toBe(true);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);

    // The final reply is NOT also persisted as a separate say() — only the "setting up…" line is.
    expect((store.appendAtlasMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((surface.post as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Setting up');
  });

  it('persists a turn_meta block LAST when the engine reports usage (per-turn tokens + context occupancy)', async () => {
    const run = vi.fn(async (args: RunEngineArgs) => {
      args.onEvent?.({ kind: 'text', text: 'Reply.' });
      return {
        result: 'Reply.',
        sessionId: 'sess-1',
        usage: {
          // `inputTokens` is the CUMULATIVE billing total (sums every round-trip's cache re-reads).
          inputTokens: 187_795,
          outputTokens: 420,
          cacheReadTokens: 180_932,
          costUsd: 0.21,
          model: 'claude-opus-4-8',
          // Occupancy = the per-call context size (the brain's real window usage), NOT the cumulative
          // billing total — read straight from the engine's per-call tracking.
          contextTokens: 23_100,
          contextModel: 'claude-opus-4-8',
        },
      };
    });
    const { manager, blockSink } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    const blocks = (blockSink.appendBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    // The turn_meta block is appended LAST in the turn.
    expect(blocks.at(-1)?.kind).toBe('turn_meta');
    const meta = blocks.at(-1)?.meta as Record<string, unknown>;
    expect(meta.usage).toMatchObject({ inputTokens: 187_795, outputTokens: 420, costUsd: 0.21, model: 'claude-opus-4-8' });
    // Occupancy reads the per-call `contextTokens`, NOT the cumulative billing `inputTokens` (the bug).
    expect(meta.contextTokens).toBe(23_100);
    expect(meta.contextTokens).not.toBe(187_795);
    expect(meta.contextLimit).toBe(1_000_000); // opus → 1M window
  });

  it('turn_meta context occupancy is null when the engine surfaces no per-call usage (no wrong ring)', async () => {
    const run = vi.fn(async (args: RunEngineArgs) => {
      args.onEvent?.({ kind: 'text', text: 'Reply.' });
      return {
        result: 'Reply.',
        sessionId: 'sess-1',
        // Billing usage only — no `contextTokens`/`contextModel` (e.g. an engine without per-call usage).
        usage: { inputTokens: 187_795, outputTokens: 420, cacheReadTokens: 180_932, model: 'claude-opus-4-8' },
      };
    });
    const { manager, blockSink } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    const blocks = (blockSink.appendBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    const meta = blocks.at(-1)?.meta as Record<string, unknown>;
    // Falls back to null (blank ring) rather than the wrong cumulative ~94%.
    expect(meta.contextTokens).toBeNull();
  });

  it('routes an unresumable-session error to a system→operator notice (own box), not an Atlas reply', async () => {
    const run = vi.fn().mockRejectedValue(
      new Error(`${UNRESUMABLE_SESSION_MARKER}: engine session ghost not found — cannot resume`),
    );
    const { manager, store, surface } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    // Persisted via the system→operator seam (own box), NOT as an Atlas message.
    expect(store.appendSystemOperatorMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    // The live post carries `meta.source='system_operator'` so the web renders the dedicated box…
    const notice = (surface.post as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[2] as { meta?: { source?: string } } | undefined)?.meta?.source === 'system_operator',
    );
    expect(notice).toBeTruthy();
    // …and it does NOT tell the operator to "try again" (retrying is futile).
    expect(String(notice![1])).not.toContain('try again');
    expect(String(notice![1]).toLowerCase()).toContain('new thread');
  });

  it('serializes concurrent turns for one thread — a follow-up queues, never two engine turns at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { result: 'ok', sessionId: 's' };
    });
    const { manager, dockerRunner } = makeManager({ findSandbox: { worktreePath: '/wt' }, run });

    const p1 = manager.handleChatTurn(stimulus); // turn 1 starts, blocks on the gate
    const p2 = manager.handleChatTurn(stimulus); // turn 2 sent while turn 1 is "thinking"
    await new Promise((r) => setTimeout(r, 10));

    // Turn 2 is queued — the engine has only been entered ONCE.
    expect((dockerRunner.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([p1, p2]);

    expect((dockerRunner.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1); // never two concurrent engine turns resuming the same session
  });

  it('posts an actionable message and does NOT run a turn when the repo is not connected', async () => {
    const ensureProvisioned = vi
      .fn()
      .mockRejectedValue(new ProvisioningNotReadyError('finish connecting this repo in settings'));
    const { manager, surface, dockerRunner } = makeManager({
      findSandbox: { worktreePath: '/wt' }, // already-provisioned → skip the "setting up" line
      ensureProvisioned,
    });

    await manager.handleChatTurn(stimulus);

    expect(dockerRunner.run).not.toHaveBeenCalled();
    expect((surface.post as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('finish connecting this repo');
  });

  it('PASSIVE awareness: an OPERATOR turn drains the buffer and PREPENDS the passive summary to the turn input', async () => {
    const drainAndAdvance = vi.fn().mockResolvedValue({
      markers: [
        { id: 'approved:dr-1', text: 'Your plan was approved by the operator.', at: '2026-06-26T00:00:00.000Z' },
      ],
      stateChanged: false,
    });
    const { manager, dockerRunner, awareness } = makeManager({ drainAndAdvance });

    await manager.handleChatTurn(stimulus); // stimulus.author.id = 'U-OP' → operator

    expect((awareness.drainAndAdvance as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(THREAD_ID);
    const runArgs = (dockerRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
    expect(runArgs.task).toContain('informational, no action needed unless asked');
    expect(runArgs.task).toContain('Your plan was approved by the operator.');
    // The operator's actual message is preserved AFTER the passive prefix.
    expect(runArgs.task).toContain('Explain the build step');
  });

  it('PASSIVE awareness: a SYNTHETIC (Atlas-authored) turn does NOT drain the buffer', async () => {
    const drainAndAdvance = vi.fn().mockResolvedValue({ markers: [], stateChanged: false });
    const { manager, dockerRunner, awareness } = makeManager({ drainAndAdvance });

    // runDirectBuild / startFollowUpThread stamp author.id = 'atlas' — these must not consume the buffer.
    const synthetic: ChatStimulus = { ...stimulus, author: { id: 'atlas', displayName: 'Atlas' } };
    await manager.handleChatTurn(synthetic);

    expect(awareness.drainAndAdvance as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const runArgs = (dockerRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
    expect(runArgs.task).toBe('Explain the build step'); // no prefix injected
  });

  it('PASSIVE awareness: a turn that fails the provisioning guard never drains the buffer', async () => {
    const drainAndAdvance = vi.fn().mockResolvedValue({ markers: [], stateChanged: false });
    const ensureProvisioned = vi
      .fn()
      .mockRejectedValue(new ProvisioningNotReadyError('finish connecting this repo in settings'));
    const { manager, dockerRunner, awareness } = makeManager({
      findSandbox: { worktreePath: '/wt' },
      ensureProvisioned,
      drainAndAdvance,
    });

    await manager.handleChatTurn(stimulus);

    expect(dockerRunner.run).not.toHaveBeenCalled();
    expect(awareness.drainAndAdvance as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('a composer message NEVER answers an open question card — even one shown BEFORE the message arrived', async () => {
    // Answers come only through the question-card component (`/answer-question`). A message typed in the
    // composer while a card is showing (card `created_at` BEFORE the operator's `receivedAt`) is a normal
    // operator turn, not the answer — the card stays open for the operator to answer via the component.
    const { manager, store } = makeManager({
      pendingCard: { ts: 'q-shown-first', created_at: new Date('2026-06-23T00:00:00Z') },
    });

    await manager.handleChatTurn(stimulus);

    expect(store.updateCardMessage).not.toHaveBeenCalled();
  });

  it('a composer message queued BEFORE the question was asked is not consumed as its answer (the original bug)', async () => {
    // The reported bug: a chat message queued while a turn ran got stamped as the answer to an
    // `ask_question` card that same turn went on to open (card `created_at` AFTER `receivedAt`).
    const { manager, store } = makeManager({
      pendingCard: { ts: 'q-asked-later', created_at: new Date('2026-06-24T00:05:00Z') },
    });

    await manager.handleChatTurn(stimulus);

    expect(store.updateCardMessage).not.toHaveBeenCalled();
  });

  it('a DELIVERY turn (seedQuestionId set) stamps exactly that card delivered on success', async () => {
    // The answer-delivery seed carries seedQuestionId; the success tail marks THAT card delivered (so the
    // boot sweep won't re-deliver it). An answered, not-yet-delivered card is the delivery target.
    const { manager, store } = makeManager({
      pendingCard: { type: 'question_card', answer: 'dynamic', deliveredAt: null },
    });
    const deliveryStimulus: ChatStimulus = { ...stimulus, seed: true, seedQuestionId: 'q-deliver' };

    await manager.handleChatTurn(deliveryStimulus);

    expect(store.markQuestionDelivered).toHaveBeenCalledWith(THREAD_ID, 'q-deliver');
  });

  it('a normal operator turn (no seedQuestionId) never marks a card delivered', async () => {
    const { manager, store } = makeManager({
      pendingCard: { type: 'question_card', answer: 'dynamic', deliveredAt: null },
    });

    await manager.handleChatTurn(stimulus);

    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
  });
});

describe('AgentSessionManager — create_thread tool (independent follow-up)', () => {
  const ORG = 'org-ct';
  const REPO = 'repo-ct';
  const THREAD = 'th-parent';

  const stimulus: ChatStimulus = {
    kind: 'chat',
    trust: 'trusted',
    id: 'stim-ct-1',
    receivedAt: new Date('2026-06-25T00:00:00Z'),
    orgId: ORG,
    repoId: REPO,
    jobId: THREAD,
    body: 'Do thing A, then a follow-up for thing B',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', threadRef: THREAD },
  };

  function makeManager(storeOverrides: Record<string, unknown> = {}) {
    const store = {
      loadJob: vi.fn().mockResolvedValue({ baseBranch: 'main' }),
      createFollowUpThread: vi.fn().mockResolvedValue('th-followup'),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      awaitingQuestionId: vi.fn().mockResolvedValue(null),
      getQuestionCard: vi.fn().mockResolvedValue(null),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
      awaitingSecretId: vi.fn().mockResolvedValue(null),
      getSecretCard: vi.fn().mockResolvedValue(null),
      markSecretDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
      setTurnActive: vi.fn().mockResolvedValue(undefined),
      ...storeOverrides,
    } as unknown as BrainStoreService;
    const manager = new AgentSessionManager(
      store,
      {} as unknown as DriverStoreService,
      {} as unknown as MemoryStore,
      {} as unknown as DecisionApprovalService,
      {} as unknown as JobLifecycleService,
      {} as unknown as EngineRunnerPort,
      { listRunning: async () => [] } as never, // turnRegistry
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      { post: vi.fn(), name: 'web' } as unknown as ChatSurface,
      { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<JobSandboxEntity>,
      { findOne: async () => null, update: async () => undefined, find: async () => [] } as never, // stimulusRows
      noopTurnHarness,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      {
        appendMarker: vi.fn().mockResolvedValue(undefined),
        drainAndAdvance: vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
      } as unknown as PipelineAwarenessStore,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      new DecisionLedgerService(),
      {
        recordPromoted: async () => undefined,
        reconcileFromBaseCheckout: async () => ({ reconciled: 0, accepted: 0, flagged: 0 }),
        reposWithGit: async () => [],
      } as unknown as RepoDecisionManifestService,
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        grant: async () => undefined,
        listGrants: async () => [],
        read: async () => null,
      } as unknown as WorktreeSecretStore,
    );
    return { manager, store };
  }

  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

  it('create_thread creates an independent follow-up (inheriting the base branch) and starts it', async () => {
    const { manager, store } = makeManager();
    const startSpy = vi.spyOn(manager, 'startFollowUpThread').mockResolvedValue(undefined);

    const result = await manager.buildTools(stimulus)['create_thread']({
      title: 'Side task',
      firstMessage: 'do the side task',
    });

    expect(result).toMatchObject({ ok: true, jobId: 'th-followup' });
    expect(mock(store.createFollowUpThread)).toHaveBeenCalledWith({
      orgId: ORG,
      repoId: REPO,
      title: 'Side task',
      baseBranch: 'main', // inherits the parent thread's base
    });
    expect(startSpy).toHaveBeenCalledWith('th-followup', ORG, REPO, 'do the side task');
  });

  it('create_thread requires a firstMessage', async () => {
    const { manager, store } = makeManager();
    const result = await manager.buildTools(stimulus)['create_thread']({ title: 'x', firstMessage: '  ' });
    expect(result).toMatchObject({ ok: false });
    expect(mock(store.createFollowUpThread)).not.toHaveBeenCalled();
  });

  it('startFollowUpThread records the opening intent, then runs one chat turn', async () => {
    const { manager, store } = makeManager();
    const turn = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.startFollowUpThread('th-followup', ORG, REPO, 'kick off the follow-up');

    expect(mock(store.appendAtlasMessage)).toHaveBeenCalledWith(
      'th-followup',
      expect.stringContaining('kick off the follow-up'),
    );
    expect(turn).toHaveBeenCalledOnce();
    const ran = (turn.mock.calls[0][0] as ChatStimulus);
    expect(ran).toMatchObject({ jobId: 'th-followup', orgId: ORG, repoId: REPO, body: 'kick off the follow-up' });
  });
});

describe('R3 gate: AgentSessionManager.deliverEvent — (b) an event reaches the ONE brain as a harness message', () => {
  const eventStimulus: EventStimulus = {
    kind: 'event',
    trust: 'untrusted',
    id: 'stim-evt-001',
    jobId: 'th-evt-001',
    receivedAt: new Date('2026-06-21T00:00:00Z'),
    orgId: 'T-EVT',
    repoId: 'evt-proj',
    body: 'CI job #42 failed on the main branch.',
    source: 'github',
    dedupeKey: 'ci-run-42',
    severity: 'warning',
  };

  /** A manager wired with only the two deps `deliverEvent` touches; everything else is an inert stub. */
  function makeManager() {
    const stimulusRows = {
      findOne: vi.fn().mockResolvedValue(null), // not yet delivered
      update: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue([]),
    };
    const inert = {} as never;
    const manager = new AgentSessionManager(
      inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, // store … surface + turnRegistry (10)
      inert, // sandboxRows (11)
      stimulusRows as never, // stimulusRows (12)
      inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, inert, // 13 … 24 (incl. secretStore)
    );
    return { manager, stimulusRows };
  }

  it('runs ONE harness turn with the framed + UNTRUSTED-fenced body, then stamps delivered_at', async () => {
    const { manager, stimulusRows } = makeManager();
    const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.deliverEvent(eventStimulus);

    expect(spy).toHaveBeenCalledOnce();
    const delivered = spy.mock.calls[0][0] as ChatStimulus;
    expect(delivered.jobId).toBe('th-evt-001');
    expect(delivered.seed).toBe(true); // a seed turn → no duplicate operator bubble
    // Trusted framing OUTSIDE the fence, the untrusted event body INSIDE it.
    expect(delivered.body).toMatch(/no human sent it/i);
    expect(delivered.body).toContain(UNTRUSTED_OPEN);
    expect(delivered.body).toContain('CI job #42 failed');
    // delivered_at stamped ONLY after the turn completed (at-least-once).
    expect(stimulusRows.update).toHaveBeenCalledWith(
      { id: 'stim-evt-001' },
      expect.objectContaining({ delivered_at: expect.any(Date) }),
    );
  });

  it('is idempotent: an already-delivered event runs no second turn', async () => {
    const { manager, stimulusRows } = makeManager();
    stimulusRows.findOne.mockResolvedValue({ delivered_at: new Date() });
    const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.deliverEvent(eventStimulus);

    expect(spy).not.toHaveBeenCalled();
    expect(stimulusRows.update).not.toHaveBeenCalled();
  });

  it('a FAILED delivery turn leaves delivered_at unstamped (so the boot sweep re-delivers)', async () => {
    const { manager, stimulusRows } = makeManager();
    vi.spyOn(manager, 'handleChatTurn').mockRejectedValue(new Error('turn crashed mid-delivery'));

    await expect(manager.deliverEvent(eventStimulus)).rejects.toThrow('turn crashed');
    // The stamp is AFTER the awaited turn → a crash never reaches it; the row stays null → re-deliverable.
    expect(stimulusRows.update).not.toHaveBeenCalled();
  });
});
