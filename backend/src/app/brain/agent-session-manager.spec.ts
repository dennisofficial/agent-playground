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
import type { DriverRepoResolver } from '../driver/repo-resolver';
import type { LiveVerificationJudge } from '../driver/live-verification-judge';
import type { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import type { TicketService } from '../tickets';
import type { JobDependencyService } from '../job-deps';
import type { DecisionClassifier } from '../decision-gate';
import type { BlockSink, ChatSurface, LiveTurnStore, TaskEventSink } from '../surface';
import { TurnHarnessFactory } from '../surface';

/** A no-op transcript harness for tests that don't exercise streaming. */
const noopTurnHarness = {
  create: () => ({
    onEvent: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(undefined),
    emitPrompt: vi.fn().mockResolvedValue(undefined),
  }),
} as unknown as TurnHarnessFactory;
import type { Repository } from 'typeorm';
import type { JobSandboxEntity } from '../persistence/entities';
import { AgentSessionManager, renderDoneDelivery, doneRecordBody } from './agent-session-manager.service';
import { ProvisioningNotReadyError } from '../driver/job-lifecycle.service';
import { UNRESUMABLE_SESSION_MARKER } from '../engine/engine.types';
import type { EngineEvent, RunEngineArgs } from '../engine/engine.types';
import type { EventStimulus } from '../domain';
import type { PlanReviewService } from './plan-review.service';
import type { TurnRecoveryService } from './turn-recovery.service';
import type { CredentialResolver, WorkspaceConfigStore, WorkspaceSecretFileStore } from '../onboarding';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import { WORKSPACE_PROFILE_TOOL_NAMES } from '../sandbox/image/workspace-profile-bridge-options';
import { TOOL_SHAPES } from '../sandbox/image/host-tool-schemas';
import { ATLAS_HOST_BRIDGE_TOOLS } from '@workspace/shared';
import type { LocalGitService } from '../git';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
import type { LeaderElectionService } from '../cluster';
import type { JitHostExecutor } from './jit-host-executor';

/** Mirrors the private `TurnDeliveryOpts` shape (not exported) — just enough for the pump tests. */
interface TurnDeliveryOptsLike {
  onRegistered?: () => void;
}

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
    // Default: no operator-set kind, so propose_plan/start_direct_build fall back to their requested kind.
    jobKind: vi.fn().mockResolvedValue(null),
    persistPlan: vi.fn(),
    route: vi.fn(),
    appendAtlasMessage: vi.fn(),
    appendSystemNotice: vi.fn().mockResolvedValue(undefined),
    appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
    hasRecentSystemOperatorNotice: vi.fn().mockResolvedValue(false),
    approve: vi.fn(),
    withdrawPlan: vi.fn(),
    cancel: vi.fn(),
    reopenPlanning: vi.fn(),
    loadJob: vi.fn(),
    buildNotStarted: vi.fn(),
    markDirectBuildStarted: vi.fn(),
    // Working-set decisions (create_decision / submit_plan source these); default to empty.
    pendingDecisions: vi.fn().mockResolvedValue([]),
    createDecision: vi.fn().mockResolvedValue({ decision: { id: 'd1' }, all: [{ id: 'd1' }] }),
    updateDecision: vi.fn().mockResolvedValue(null),
    deleteDecision: vi.fn().mockResolvedValue({ removed: false, all: [] }),
    appendCardMessage: vi.fn(),
    updateCardMessage: vi.fn(),
    latestAnsweredQuestionCard: vi.fn().mockResolvedValue(null),
    // Milestone-compaction gate reads brain occupancy; a lean session ⇒ skip the compaction turn (no-op here).
    latestBrainOccupancy: vi.fn().mockResolvedValue({ contextTokens: 0, contextLimit: 1_000_000 }),
    // Durable human-input gate (ask_question lifecycle, per-card — stacking is allowed, no single-slot).
    nextQuestionId: vi.fn().mockResolvedValue('q1'),
    openQuestion: vi.fn().mockResolvedValue({ ok: true }),
    getQuestionCard: vi.fn().mockResolvedValue(null),
    markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
    findUndeliveredAnsweredQuestions: vi.fn().mockResolvedValue([]),
    // Open-question surfacing + withdraw (the "stop re-asking" fixes); default to "none open" / "withdrew ok".
    openQuestionCards: vi.fn().mockResolvedValue([]),
    withdrawQuestion: vi.fn().mockResolvedValue({ withdrawn: true }),
    // Secure secret-request gate (request_secret lifecycle); default to "no request open".
    openSecretRequest: vi.fn().mockResolvedValue({ ok: true }),
    awaitingSecretId: vi.fn().mockResolvedValue(null),
    getSecretCard: vi.fn().mockResolvedValue(null),
    markSecretProvided: vi.fn().mockResolvedValue(undefined),
    markSecretDelivered: vi.fn().mockResolvedValue(undefined),
    clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
    findUndeliveredProvidedSecrets: vi.fn().mockResolvedValue([]),
    // MCP-proposal gate (propose_mcp_servers lifecycle); default to "opened ok".
    openMcpProposal: vi.fn().mockResolvedValue({ ok: true }),
    getMcpProposalCard: vi.fn().mockResolvedValue(null),
    markMcpProposalApproved: vi.fn().mockResolvedValue(undefined),
    // R4 async plan-review seam.
    appendSystemEvent: vi.fn().mockResolvedValue(undefined),
    markAwaitingApproval: vi.fn().mockResolvedValue(undefined),
    loadDecisionRecord: vi.fn(),
    appendReviewFindingsMessage: vi.fn().mockResolvedValue(true),
    threadTicketId: vi.fn().mockResolvedValue(null),
    // ADR-0005 direct-build live-verification verdict (persisted on both pass + refusal paths).
    recordDirectBuildVerification: vi.fn().mockResolvedValue(undefined),
    // The "needs you" activity axis is best-effort; the manager brackets every chat turn with it.
    setActivity: vi.fn().mockResolvedValue(undefined),
    endTurnActivity: vi.fn().mockResolvedValue(undefined),
    setHalted: vi.fn().mockResolvedValue(undefined),
    resetAllActivity: vi.fn().mockResolvedValue(0),
  } as unknown as BrainStoreService;

  const mockDriverStore = {
    getPipelineState: vi.fn(),
    getDecisionRecord: vi.fn(),
    retractShip: vi.fn(),
    openAmendProposal: vi.fn(),
    // ADR 0004 Phase 3 — halt wake + bounded fix
    loadJob: vi.fn(),
    getThread: vi.fn(),
    getTerminalRecord: vi.fn(),
    resolveSessionAnchor: vi.fn().mockResolvedValue(undefined),
    claimHaltFixAttempt: vi.fn(),
    markHaltWaked: vi.fn(),
    // Decision d1 — completion wake (gen-CAS): claim returns a gen so the delivery proceeds; supersede no-ops.
    threadsForJob: vi.fn().mockResolvedValue([]),
    claimDoneWakeGen: vi.fn().mockResolvedValue(1),
    supersedeDoneWakeMessages: vi.fn().mockResolvedValue(undefined),
    markDoneWaked: vi.fn(),
  } as unknown as DriverStoreService;

  const mockMemory = {
    recall: vi.fn(),
    remember: vi.fn(),
  } as unknown as MemoryStore;

  const mockApprovals = {
    request: vi.fn(),
    cancel: vi.fn(),
    resolve: vi.fn(),
  } as unknown as DecisionApprovalService;

  const mockLifecycle = {
    findSandbox: vi.fn(),
    contextDirHost: vi.fn(),
    markRepoOnboarded: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobLifecycleService;

  const mockSecretStore = {
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    listForRepo: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(null),
  } as unknown as WorkspaceSecretFileStore;

  const mockConfigStore = {
    listMounts: vi.fn().mockResolvedValue([]),
    upsertMount: vi.fn().mockResolvedValue(undefined),
    getSetupScript: vi.fn().mockResolvedValue(null),
    setSetupScript: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceConfigStore;

  const mockGit = {
    hasChanges: vi.fn().mockResolvedValue(false),
    // The brain turn observes the live branch (detached HEAD → null); default to null so no live-branch
    // backstop fires in these streaming/tool tests.
    currentBranch: vi.fn().mockResolvedValue(null),
    // Hard-reset safety guard: a clean, pushed tree is safe to re-cut by default.
    worktreeSafeToRecut: vi.fn().mockResolvedValue(true),
    // ADR-0005 direct-build gate reads the changed files (vs origin/<default>) to decide runtime-touch.
    // Default: empty → the pre-filter passes without consulting the judge (keeps all existing ship tests green).
    changedFileNames: vi.fn().mockResolvedValue([]),
  } as unknown as LocalGitService;

  // ADR-0005 live-verification judge — a mutable stub so gate tests set the verdict per case. Default
  // (undefined) never matters for non-gate tests: their empty changed-file set short-circuits the pre-filter
  // before the judge is consulted.
  const mockJudge = {
    judge: vi.fn().mockResolvedValue(undefined),
  } as unknown as LiveVerificationJudge & { judge: ReturnType<typeof vi.fn> };

  const mockDockerRunner = {} as unknown as EngineRunnerPort;

  // Fast-path deps: classify (default → proceed), ship, repo resolve.
  const mockClassifier = {
    classify: vi.fn().mockResolvedValue({ verdict: 'proceed', reason: '', via: 'rule' }),
  } as unknown as DecisionClassifier;

  const mockShip = {
    // Driver/boot path (brain idle) — seeds the open-PR turn + latches.
    ship: vi.fn().mockResolvedValue({ opened: true, prConfirmed: true, url: 'https://gh/pr/1', number: 1 }),
    // Mid-turn callers (finalize_build / finish_onboarding) use the host gate; the brain opens the PR inline.
    preShip: vi.fn().mockResolvedValue({ ok: true }),
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
   * The synchronous PlanReviewService. `review` returns a clean outcome by default; `reviewForCurrentSpecs`
   * is the propose_plan mandatory-run gate — default returns a terminal row (a review has run), so
   * propose_plan is allowed. `findRunningReviews` backs the work-owed backstop.
   */
  const mockPlanReview = {
    review: vi.fn().mockResolvedValue({ status: 'complete', findings: [], specHash: null }),
    reviewForCurrentSpecs: vi
      .fn()
      .mockResolvedValue({ row: { status: 'complete', findings: null, error: null }, specHash: null }),
    findRunningReviews: vi.fn().mockResolvedValue([]),
    reviewCeiling: 8,
  } as unknown as PlanReviewService;

  const mockDispatcher = {
    dispatch: vi.fn(),
    redriveThread: vi.fn(), // ADR 0004 Phase 3 — the brain's autonomous re-drive (retry_thread → this)
  } as unknown as JobDispatcher;

  // Thread 6 — the host-side JIT executor: approval now fires 'plan-approved' through this instead of
  // dispatching/implementing directly.
  const mockJit = {
    fireLifecycle: vi.fn(),
    collectOperatorPrepends: vi.fn().mockReturnValue([]),
  } as unknown as JitHostExecutor;

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
    replyRoute: { surfaceId: 'agent', jobRef: 'ts-r3gate-001' },
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

    // resetAllMocks wiped the file-scope default — re-arm it so notifyThreadHalted's anchor resolve returns a
    // Promise (not undefined) for the tests that don't stub it themselves.
    (mockDriverStore.resolveSessionAnchor as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // Decision d1 completion-wake gen-CAS defaults (resetAllMocks wiped them): claim yields a gen so the
    // notifyThreadDone delivery proceeds, and the supersede/threadsForJob are no-op promises.
    (mockDriverStore.claimDoneWakeGen as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (mockDriverStore.supersedeDoneWakeMessages as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockDriverStore.threadsForJob as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Passive-awareness defaults (resetAllMocks wiped the resolved values) — append is a no-op promise.
    (mockAwareness.appendMarker as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockAwareness.drainAndAdvance as ReturnType<typeof vi.fn>).mockResolvedValue({
      markers: [],
      stateChanged: false,
    });

    // Secret-store defaults (resetAllMocks wiped the resolved values) — no existing value by default.
    (mockSecretStore.write as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockSecretStore.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockSecretStore.listForRepo as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockSecretStore.read as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Config-store + git defaults (resetAllMocks wiped the resolved values).
    (mockConfigStore.listMounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockConfigStore.upsertMount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockGit.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Activity-axis writers are best-effort promises (resetAllMocks wiped the inline resolves); the
    // review_plan handler re-asserts `turn` after the review, so setActivity must resolve.
    (mockStore.setActivity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.endTurnActivity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.setHalted as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.resetAllActivity as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    // By default: no existing open job on the thread → openJob creates a fresh one.
    (mockStore.openJobOnThread as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.openJob as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_JOB_ID);
    // Default loadJob: no prior job state (propose_plan's idempotency guard proceeds; other tests override).
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.buildNotStarted as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockStore.markDirectBuildStarted as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockDriverStore.retractShip as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Working-set decisions default to empty; card lookups default to none (reset wiped inline defaults).
    (mockStore.pendingDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockStore.createDecision as ReturnType<typeof vi.fn>).mockResolvedValue({
      decision: { id: 'd1' },
      all: [{ id: 'd1' }],
    });
    (mockStore.updateDecision as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.deleteDecision as ReturnType<typeof vi.fn>).mockResolvedValue({ removed: false, all: [] });
    (mockStore.latestAnsweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Milestone-compaction gate reads brain occupancy; a lean session ⇒ skip the fire-and-forget compaction turn.
    (mockStore.latestBrainOccupancy as ReturnType<typeof vi.fn>).mockResolvedValue({
      contextTokens: 0,
      contextLimit: 1_000_000,
    });
    // Human-input gate defaults: opening succeeds, no question currently open.
    (mockStore.nextQuestionId as ReturnType<typeof vi.fn>).mockResolvedValue('q1');
    (mockStore.openQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Secure secret-request + MCP-proposal gates default to "opened ok" (resetAllMocks wiped the inline defaults).
    (mockStore.openSecretRequest as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (mockStore.openMcpProposal as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (mockStore.markQuestionDelivered as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockLifecycle.contextDirHost as ReturnType<typeof vi.fn>).mockReturnValue('/tmp/atlas-test-ctx');
    (mockLifecycle.markRepoOnboarded as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Plan-review defaults (resetAllMocks wiped resolved values). appendSystemEvent MUST resolve a promise
    // — propose_plan chains `.catch` on it. review() defaults clean; the propose_plan gate defaults to "a
    // review has run for the current specs" (a terminal row) so propose is allowed unless a test overrides.
    (mockStore.appendSystemEvent as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // ADR-0005 direct-build gate defaults (resetAllMocks wiped the declared resolves): an empty changed-file
    // set → pre-filter passes without the judge; persistence is a resolved no-op; the judge returns undefined
    // unless a gate test overrides it.
    (mockGit.changedFileNames as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (mockStore.recordDirectBuildVerification as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockJudge.judge as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.threadTicketId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockPlanReview.review as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'complete',
      findings: [],
      specHash: null,
    });
    (mockPlanReview.reviewForCurrentSpecs as ReturnType<typeof vi.fn>).mockResolvedValue({
      row: { status: 'complete', findings: null, error: null },
      specHash: null,
    });
    (mockPlanReview.findRunningReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);

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
    (mockStore.appendSystemNotice as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

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
      {
        eligiblePendingChat: async () => [],
        leaseChatStimuli: async () => undefined,
        markChatDelivered: async () => undefined,
        undeliveredChatThreads: async () => [],
        resetChatLeases: async () => undefined,
        findChatStimulusById: async () => null,
      } as never, // stimulusStore
      noopTurnHarness,
      mockClassifier,
      mockShip,
      mockRepos,
      mockAwareness,
      {} as unknown as TicketService,
      {} as unknown as JobDependencyService,
      {
        engineAuth: async () => undefined,
        openaiKey: async () => undefined,
        // The direct-build gate consults this only to phrase a "no key" refusal; default → no key configured.
        anthropicKey: async () => undefined,
      } as unknown as CredentialResolver,
      { resolveForTurn: async () => [] } as never, // mcp (McpResolver)
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      mockSecretStore,
      mockConfigStore,
      mockGit,
      { generate: () => 'SYSTEM PROMPT' } as never, // prompts (PromptService)
      { register: () => undefined } as never, // threadInput (ThreadInputService)
      mockJudge, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (OauthUsageService)
      undefined, // usageProjector
      undefined, // env
      undefined, // conventions
      undefined, // workspaceProfile
      undefined, // skills
      undefined, // skillStore
      undefined, // skillFiles
      undefined, // skillInstaller
      undefined, // mcpStore
      undefined, // scheduler
      undefined, // brainGateway
      undefined, // reattachRegistry
      mockJit, // jit
    );
  });

  it('(a) propose_plan: persists (awaiting_approval) + posts the approval card, gated on a run review', async () => {
    const tools = manager.buildTools(fakeStimulus);

    const goal = 'Add rate limiting to the public API';
    const overview = 'Add token-bucket rate limiting to the public API endpoints.';
    const decisions = [
      {
        decisionClass: 'infrastructure',
        title: 'Rate-limit backend',
        ruling: 'Use a Redis token bucket (per-IP, 100 req/min) via the existing RedisService.',
      },
    ];
    const threads = [
      {
        title: 'RateLimiter guard',
        steps: [{ title: 'Add the guard', brief: 'Create RateLimiterGuard in src/guards/rate-limiter.guard.ts:1 …' }],
      },
      { title: 'Integration tests', steps: [{ title: 'Cover 429s', brief: 'Add rate-limit.int.test.ts …' }] },
    ];
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'Add token-bucket rate limiting.',
      decisions: [{ decisionClass: 'infrastructure', title: 'Backend', ruling: 'Redis bucket' }],
      threadTitles: ['RateLimiter guard', 'Integration tests'],
    });

    const result = await tools['propose_plan']({ goal, overview, decisions, threads });

    // 1. The mandatory-run gate was checked (a review must have run for the current specs).
    expect(mockPlanReview.reviewForCurrentSpecs).toHaveBeenCalledWith(FAKE_JOB_ID, TEAM_ID);
    // 2. persistPlan persists straight to `awaiting_approval` (no plan_review), with the threads + title.
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.title).toBe(goal);
    expect(persistArgs.threadTitles).toEqual(['RateLimiter guard', 'Integration tests']);
    expect(persistArgs.status).toBe('awaiting_approval');
    expect(persistArgs.kind).toBe('feature'); // default kind when none passed
    // 3. The approval card is posted async, and the review disposition lands as a system event.
    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID, decisionRecordId: FAKE_RECORD_ID });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    expect(mockStore.appendSystemEvent).toHaveBeenCalled();
  });

  it('propose_plan: kind:"bugfix" is persisted (lights up the reproduce-first job-kind block)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'o',
      decisions: [],
      threadTitles: ['S'],
    });
    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'some overview',
      kind: 'bugfix',
      threads: [{ title: 'S', type: 'backend' }],
    });
    expect(result).toMatchObject({ ok: true });
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.kind).toBe('bugfix');
    expect(mockStore.openJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bugfix' }),
    );
  });

  it('propose_plan: REFUSES (no persist, no card) when no review has run for the current specs', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockPlanReview.reviewForCurrentSpecs as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('review_plan');
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('propose_plan: a FAILED (errored) review still satisfies the gate (infra outage never blocks)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockPlanReview.reviewForCurrentSpecs as ReturnType<typeof vi.fn>).mockResolvedValue({
      row: { status: 'failed', findings: null, error: 'Codex Exec exited 1' },
      specHash: null,
    });
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'o',
      decisions: [],
      threadTitles: ['S'],
    });

    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });

    expect(result).toMatchObject({ ok: true });
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
  });

  it('propose_plan: re-proposing over an already-pending plan durably WITHDRAWS it first (no hard no-op, no orphaned handle)', async () => {
    // The old hard idempotency short-circuit is gone: `prepareRepropose` now durably retracts the
    // pending proposal (atomic flip + supersede) and drops its live handle BEFORE persisting the fresh
    // one, so re-proposing always ends with exactly one pending card — never a silent no-op.
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'awaiting_approval',
      decisionRecordId: FAKE_RECORD_ID,
    });
    (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: true });
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'o',
      decisions: [],
      threadTitles: ['S'],
    });

    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });

    expect(mockStore.withdrawPlan).toHaveBeenCalledWith(THREAD_ID, expect.any(String));
    expect(mockApprovals.cancel).toHaveBeenCalledWith(THREAD_ID, expect.any(String));
    expect(mockPlanReview.reviewForCurrentSpecs).toHaveBeenCalled();
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, decisionRecordId: FAKE_RECORD_ID });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
  });

  it('propose_plan: prepareRepropose REFUSES (no persist, no card) when withdrawPlan loses the race (an approval/cancel landed first)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'awaiting_approval',
      decisionRecordId: FAKE_RECORD_ID,
    });
    (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: false });

    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });

    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
    expect(mockApprovals.cancel).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('review_plan: runs the synchronous review and returns severity-tagged findings in the result', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockPlanReview.review as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'complete',
      findings: [
        { severity: 'BLOCKING', text: 'schema gap' },
        { severity: 'ADVISORY', text: 'rename it' },
      ],
      specHash: 'h',
    });

    const result = await tools['review_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });

    expect(mockPlanReview.review).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, reviewStatus: 'findings', blocking: 1, advisory: 1 });
    expect((result as { message: string }).message).toContain('BLOCKING');
    // review_plan NEVER posts the approval card.
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('review_plan: a failed review surfaces the failure (not a clean pass)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockPlanReview.review as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'failed',
      findings: [],
      specHash: null,
      error: 'Codex Exec exited 1',
    });
    const result = await tools['review_plan']({
      goal: 'g',
      overview: 'o',
      threads: [{ title: 'S', type: 'backend' }],
    });
    expect(result).toMatchObject({ ok: true, reviewStatus: 'failed' });
    expect((result as { message: string }).message).toContain('INFRASTRUCTURE');
  });

  it('review_plan: anchors the job WITHOUT a "plan review" placeholder title (empty when goal/overview absent)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockPlanReview.review as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'complete',
      findings: [],
      specHash: 'h',
    });

    // Normal full-path flow: goal/overview go to propose_plan, not review_plan — so both are absent here.
    await tools['review_plan']({ threads: [{ title: 'S', type: 'backend' }] });

    expect(mockStore.openJob).toHaveBeenCalledOnce();
    const openArgs = (mockStore.openJob as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(openArgs.title).toBe('');
    expect(openArgs.title).not.toBe('plan review');
  });

  it('(a) propose_plan: returns error (no persist) if goal is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['propose_plan']({
      overview: 'some overview',
      threads: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) propose_plan: step-free threads persist (steps optional → driver JIT-plans)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'o',
      decisions: [],
      threadTitles: ['S'],
    });
    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'some overview',
      threads: [{ title: 'S', type: 'backend' }],
    });
    expect(result).toMatchObject({ ok: true });
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.threadTitles).toEqual(['S']);
    expect(persistArgs.threadTypes).toEqual(['backend']);
    expect(persistArgs.stepsByThread).toBeUndefined();
  });

  it('(a) propose_plan: an off-vocabulary thread `type` coerces to the `general` fallback', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'o',
      decisions: [],
      threadTitles: ['S', 'T', 'U'],
    });
    const result = await tools['propose_plan']({
      goal: 'g',
      overview: 'some overview',
      threads: [
        { title: 'S', type: 'analytics' }, // dropped legacy label → general
        { title: 'T', type: 'BACKEND' }, // valid, case-insensitive → backend
        { title: 'U' }, // absent → general
      ],
    });
    expect(result).toMatchObject({ ok: true });
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.threadTypes).toEqual(['general', 'backend', 'general']);
  });

  it('(a) propose_plan: returns error if overview is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['propose_plan']({
      goal: 'g',
      threads: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) propose_plan: returns error if threads are missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['propose_plan']({
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
      kind: 'bugfix',
    });

    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
    // Minimal record: no threads.
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.threadTitles).toEqual([]);
    expect(persistArgs.overview).toContain('off-by-one');
    expect(persistArgs.kind).toBe('bugfix'); // kind flows through the direct-build path too

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

  it('(c) finalize_build: an APPROVED (running) direct build ships (Atlas opens the PR in-sandbox)', async () => {
    // Regression: finalize_build previously resolved the job via openJobOnThread (planning-only), so once
    // approval flipped the job to 'running' the gate ALWAYS returned "No open job — nothing to finalize"
    // and the PR was never opened. It must now load the running job by id and ship it.
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'running',
      title: 'Fix the pagination cursor',
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'sbx-1',
      branch: 'feature/abc12345',
    });
    (mockDriverStore.getDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'Fix off-by-one',
      decisions: [],
    });
    (mockRepos.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      token: 't',
    });
    // Mid-turn: the host gate passes; finalize_build hands the open-PR instructions back so the brain opens
    // the PR inline in THIS turn (no separate ship session). The reconciler latches the url + flips done.
    (mockShip.preShip as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    // ADR 0004 rider 3 — finalize_build refuses to ship until the turn has self-reported a clean verification.
    await tools['report_verification']({ passed: true });
    const result = await tools['finalize_build']({});

    expect(mockShip.preShip).toHaveBeenCalledOnce();
    // The old planning-only lookup must NOT gate this path anymore.
    expect(mockStore.openJobOnThread).not.toHaveBeenCalled();
    // The tool returns the open-PR instructions for the brain to act on in-turn (host no longer opens it).
    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
    expect((result as { message: string }).message).toContain('gh pr create');
  });

  it('(c) finalize_build: a leak-scan block returns a hard failure (brain must clean the branch)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'running',
      title: 'Fix the pagination cursor',
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'sbx-1' });
    (mockDriverStore.getDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
      overview: 'x',
      decisions: [],
    });
    (mockRepos.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      token: 't',
    });
    (mockShip.preShip as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'leak-scan',
      leaked: ['.env.keys'],
    });

    await tools['report_verification']({ passed: true });
    const result = await tools['finalize_build']({});

    expect(mockShip.preShip).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, jobId: FAKE_JOB_ID });
    expect((result as { reason: string }).reason).toContain('.env.keys');
  });

  it('(c) finalize_build: refuses a non-running job (no ship)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'planning',
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });

    const result = await tools['finalize_build']({});

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("'planning'");
    expect(mockShip.preShip).not.toHaveBeenCalled();
  });

  // ADR-0005 live-verification gate on the DIRECT-BUILD ship path — the brain-owned analog of the driver's
  // `complete_thread` gate (`thread-driver.service.spec.ts`). `finalize_build` runs the SAME judge port over
  // the changed files + the structured evidence reported via `report_verification`, and REFUSES the tool
  // (mid-turn, no halt machinery) on a touched-but-inadequate verdict. Always-on, fail-closed, no dial.
  describe('(c) finalize_build — ADR-0005 live-verification gate', () => {
    // Stand up an APPROVED (running) direct build ready to ship, with a sandbox + resolved repo + a
    // reported verification pass. Tests vary the changed files + the judge verdict.
    const armReadyToFinalize = () => {
      (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: FAKE_JOB_ID,
        status: 'running',
        title: 'Add a /health endpoint',
        repoId: PROJECT_ID,
        orgId: TEAM_ID,
      });
      (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'sbx-1',
        worktreePath: '/w/feat',
        branch: 'atlas/health',
      });
      (mockDriverStore.getDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        overview: 'Add a health endpoint',
        decisions: [],
      });
      (mockRepos.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
        owner: 'o',
        repo: 'r',
        defaultBranch: 'main',
        token: 't',
      });
      (mockShip.preShip as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    };

    it('touched + adequate → ships (judge consulted with the changed files, preShip runs, verdict persisted)', async () => {
      const tools = manager.buildTools(fakeStimulus);
      armReadyToFinalize();
      (mockGit.changedFileNames as ReturnType<typeof vi.fn>).mockResolvedValue([
        'src/app/api/health.controller.ts',
      ]);
      (mockJudge.judge as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtimeSurfaceTouched: true,
        liveVerificationAdequate: true,
        reason: 'curl /health → 200',
      });

      await tools['report_verification']({
        passed: true,
        verification: [{ kind: 'curl', command: 'curl localhost:3000/health', exitCode: 0, outputTail: '200 OK' }],
      });
      const result = await tools['finalize_build']({});

      // The judge saw exactly what git reported as changed (the diff-fed regression).
      expect(mockJudge.judge).toHaveBeenCalledOnce();
      expect((mockJudge.judge as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
        changedFiles: ['src/app/api/health.controller.ts'],
      });
      // Adequate → falls through to preShip and hands the open-PR instructions back.
      expect(mockShip.preShip).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
      expect((result as { message: string }).message).toContain('gh pr create');
      // Verdict persisted on the PASS path too (the observability hook).
      expect(mockStore.recordDirectBuildVerification).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        expect.objectContaining({
          verdict: expect.objectContaining({ runtimeSurfaceTouched: true, liveVerificationAdequate: true }),
        }),
      );
    });

    it('touched + INADEQUATE → REFUSES the tool (no preShip), names the missing checks, persists the verdict', async () => {
      const tools = manager.buildTools(fakeStimulus);
      armReadyToFinalize();
      (mockGit.changedFileNames as ReturnType<typeof vi.fn>).mockResolvedValue([
        'src/app/api/health.controller.ts',
      ]);
      (mockJudge.judge as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtimeSurfaceTouched: true,
        liveVerificationAdequate: false,
        reason: 'only typechecked',
        missingChecks: 'curl the /health endpoint against a running server',
      });

      // The brain claims passed but never actually exercised the endpoint.
      await tools['report_verification']({ passed: true });
      const result = await tools['finalize_build']({});

      expect(result).toMatchObject({ ok: false, jobId: FAKE_JOB_ID });
      expect((result as { reason: string }).reason).toContain('Live validation inadequate');
      expect((result as { reason: string }).reason).toContain('curl the /health endpoint');
      // Refusal is BEFORE the host ship gate — no preShip, no PR.
      expect(mockShip.preShip).not.toHaveBeenCalled();
      // Verdict persisted on the REFUSE path (the whole point of the audit hook) + a quiet pill.
      expect(mockStore.recordDirectBuildVerification).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        expect.objectContaining({
          verdict: expect.objectContaining({ liveVerificationAdequate: false }),
        }),
      );
      expect(mockStore.appendSystemEvent).toHaveBeenCalled();
    });

    it('docs-only diff → pre-filter SKIPS the judge entirely and ships', async () => {
      const tools = manager.buildTools(fakeStimulus);
      armReadyToFinalize();
      (mockGit.changedFileNames as ReturnType<typeof vi.fn>).mockResolvedValue([
        'docs/health.md',
        'README.md',
      ]);

      await tools['report_verification']({ passed: true });
      const result = await tools['finalize_build']({});

      expect(mockJudge.judge).not.toHaveBeenCalled();
      expect(mockShip.preShip).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
      // Pre-filter verdict is a non-runtime pass.
      expect(mockStore.recordDirectBuildVerification).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        expect.objectContaining({
          verdict: expect.objectContaining({ runtimeSurfaceTouched: false, liveVerificationAdequate: true }),
        }),
      );
    });

    it('judge UNAVAILABLE (undefined) on a runtime diff → conservative refusal, never a silent ship', async () => {
      const tools = manager.buildTools(fakeStimulus);
      armReadyToFinalize();
      (mockGit.changedFileNames as ReturnType<typeof vi.fn>).mockResolvedValue([
        'src/app/api/health.controller.ts',
      ]);
      (mockJudge.judge as ReturnType<typeof vi.fn>).mockResolvedValue(undefined); // no key / malformed

      await tools['report_verification']({ passed: true });
      const result = await tools['finalize_build']({});

      expect(result).toMatchObject({ ok: false, jobId: FAKE_JOB_ID });
      // The mocked CredentialResolver reports no anthropic key → the refusal calls that out.
      expect((result as { reason: string }).reason).toContain('no Anthropic API key');
      expect(mockShip.preShip).not.toHaveBeenCalled();
    });
  });

  it('write_workspace_config UPSERTS mounts straight to the DB — no sandbox needed, instant for every job on the repo', async () => {
    // What the ceremony (or an earlier amendment) already recorded, per the config store.
    (mockConfigStore.listMounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '.gcloud', mode: 'shared-rw' },
      { path: '.cache/turbo', mode: 'per-thread' },
      { path: '.stripe', mode: 'shared-rw' },
    ]);
    const tools = manager.buildTools(fakeStimulus);

    // A build thread discovers it needs ONE new mount — it does NOT resend the existing ones.
    const result = await tools['write_workspace_config']({
      mounts: [{ path: '.stripe', mode: 'shared-rw' }],
    });

    expect(mockConfigStore.upsertMount).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID, '.stripe', 'shared-rw');
    // No sandbox lookup — this is a pure DB write now.
    expect(mockLifecycle.findSandbox).not.toHaveBeenCalled();
    // Reports the total AFTER the write (from the store, which the test seeded to reflect it).
    expect(result).toMatchObject({ ok: true, mounts: 3 });
    expect(mockStore.appendSystemEvent).toHaveBeenCalledOnce();
    const notice = (mockStore.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(notice).toMatch(/3 mount/);
  });

  it('write_workspace_config upserts by path — re-recording the same path replaces its mode, not a duplicate call', async () => {
    const tools = manager.buildTools(fakeStimulus);

    await tools['write_workspace_config']({
      mounts: [{ path: '.gcloud', mode: 'shared-rw' }], // corrects the mode for an existing path
    });

    // The upsert-by-path semantics live in the store itself (see workspace-config.store.spec.ts); the tool's
    // job is just to call it once per entry with the normalized path/mode.
    expect(mockConfigStore.upsertMount).toHaveBeenCalledOnce();
    expect(mockConfigStore.upsertMount).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID, '.gcloud', 'shared-rw');
  });

  it('write_workspace_config accepts an ABSOLUTE (external) mount and drops one targeting a reserved container path', async () => {
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['write_workspace_config']({
      mounts: [
        { path: '/root/.config/gcloud', mode: 'shared-rw' }, // external → recorded verbatim
        { path: '/etc/foo', mode: 'shared-rw' }, // reserved container path → dropped + warned
      ],
    });

    expect(mockConfigStore.upsertMount).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID, '/root/.config/gcloud', 'shared-rw');
    expect(mockConfigStore.upsertMount).not.toHaveBeenCalledWith(TEAM_ID, PROJECT_ID, '/etc/foo', 'shared-rw');
    expect((result as { warnings?: string[] }).warnings?.some((w) => w.includes('/etc/foo'))).toBe(true);
  });

  it('write_workspace_config rejects a `secrets` field — secrets never go through this tool', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['write_workspace_config']({ secrets: [{ name: 'x' }] });
    expect(result).toMatchObject({ ok: false });
    expect(mockConfigStore.upsertMount).not.toHaveBeenCalled();
  });

  it('write_workspace_config NEVER throws on a store failure — warns and hands Atlas the real error to act on', async () => {
    (mockConfigStore.upsertMount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connect ECONNREFUSED'));
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['write_workspace_config']({ mounts: [{ path: '.gcloud', mode: 'shared-rw' }] });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('ECONNREFUSED') });
    // No misleading "success" notice was posted for a write that never landed.
    expect(mockStore.appendSystemEvent).not.toHaveBeenCalled();
  });

  it('derive_secret stores a value Atlas computed itself — no operator wait, straight to the encrypted store as a repo secret file', async () => {
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['derive_secret']({
      name: 'STRIPE_WEBHOOK_SECRET',
      path: 'backend/.env.personal',
      value: 'whsec_abc123',
      description: 'from stripe listen --print-secret, derived from the granted STRIPE_API_KEY',
    });

    expect(result).toMatchObject({ ok: true, name: 'STRIPE_WEBHOOK_SECRET', overwritten: false });
    // One write IS the value + the authority: (repo, path) identity, name as the display label.
    expect(mockSecretStore.write).toHaveBeenCalledWith(
      TEAM_ID,
      PROJECT_ID,
      'backend/.env.personal',
      'whsec_abc123',
      'STRIPE_WEBHOOK_SECRET',
    );
    // Visible to the operator (name/path only) — never the value.
    expect(mockStore.appendSystemEvent).toHaveBeenCalledOnce();
    const notice = (mockStore.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(notice).toContain('STRIPE_WEBHOOK_SECRET');
    expect(notice).not.toContain('whsec_abc123');
  });

  it('derive_secret REFUSES to clobber an existing value by default (no overwrite flag)', async () => {
    (mockSecretStore.read as ReturnType<typeof vi.fn>).mockResolvedValue('sk_live_already_here');
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['derive_secret']({
      name: 'STRIPE_API_KEY',
      path: '.stripe/api.key',
      value: 'sk_live_new',
      description: 'attempted overwrite',
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('already exists');
    expect(mockSecretStore.write).not.toHaveBeenCalled();
  });

  it('derive_secret allows an EXPLICIT overwrite: true to replace an existing value', async () => {
    (mockSecretStore.read as ReturnType<typeof vi.fn>).mockResolvedValue('whsec_stale');
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['derive_secret']({
      name: 'STRIPE_WEBHOOK_SECRET',
      path: 'backend/.env.personal',
      value: 'whsec_fresh',
      description: 'rotated after re-running stripe listen',
      overwrite: true,
    });

    expect(result).toMatchObject({ ok: true, overwritten: true });
    expect(mockSecretStore.write).toHaveBeenCalledWith(
      TEAM_ID,
      PROJECT_ID,
      'backend/.env.personal',
      'whsec_fresh',
      'STRIPE_WEBHOOK_SECRET',
    );
  });

  it('derive_secret validates name/path/value/description before touching the store', async () => {
    const tools = manager.buildTools(fakeStimulus);

    const badName = await tools['derive_secret']({
      name: 'not a valid name!',
      path: '.env',
      value: 'x',
      description: 'x',
    });
    expect(badName).toMatchObject({ ok: false });

    const badPath = await tools['derive_secret']({
      name: 'X',
      path: '/etc/passwd',
      value: 'x',
      description: 'x',
    });
    expect(badPath).toMatchObject({ ok: false });

    const noValue = await tools['derive_secret']({ name: 'X', path: '.env', description: 'x' });
    expect(noValue).toMatchObject({ ok: false });

    const noDescription = await tools['derive_secret']({ name: 'X', path: '.env', value: 'x' });
    expect(noDescription).toMatchObject({ ok: false });

    expect(mockSecretStore.write).not.toHaveBeenCalled();
  });

  it('read_setup_script returns the stored script (read-before-edit for write_setup_script)', async () => {
    const getSetupScript = mockConfigStore.getSetupScript as ReturnType<typeof vi.fn>;
    getSetupScript.mockResolvedValueOnce(null);
    const tools = manager.buildTools(fakeStimulus);

    // Unset → present:false, script:null.
    const empty = await tools['read_setup_script']({});
    expect(empty).toEqual({ ok: true, present: false, script: null });
    expect(getSetupScript).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID);

    // Set → the raw body is surfaced verbatim (not just its length like the profile snapshot).
    const body = '#!/usr/bin/env bash\nset -euo pipefail\npnpm install --frozen-lockfile';
    getSetupScript.mockResolvedValueOnce(body);
    const present = await tools['read_setup_script']({});
    expect(present).toEqual({ ok: true, present: true, script: body });

    // Pure read — never mutates.
    expect(mockConfigStore.setSetupScript).not.toHaveBeenCalled();
  });

  it('read_setup_script resolves in buildTools for normal + onboarding kinds', () => {
    for (const kind of [null, 'onboarding'] as const) {
      const tools = manager.buildTools(fakeStimulus, kind);
      expect(typeof tools['read_setup_script'], `kind=${kind}`).toBe('function');
    }
  });

  it('finish_onboarding refuses without a substantive `verified` (green-gate)', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['finish_onboarding']({ summary: 'done', verified: 'too short' });
    expect(result).toMatchObject({ ok: false });
    expect(mockLifecycle.markRepoOnboarded).not.toHaveBeenCalled();
  });

  // Drift guard: every name the workspace-profile bridge routes MUST be a real, registered tool, or the
  // entrypoint would advertise a tool that doesn't dispatch. Onboarding is the superset (includes the
  // convention tools), so it's the right toolset to check membership against.
  it('WORKSPACE_PROFILE_TOOL_NAMES all resolve to registered tools (no bridge/registration drift)', () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    for (const name of WORKSPACE_PROFILE_TOOL_NAMES) {
      expect(typeof tools[name], `profile tool "${name}" must be registered`).toBe('function');
    }
    // Conversely, reset_sandbox is a real tool but deliberately NOT on the profile bridge.
    expect(typeof tools['reset_sandbox']).toBe('function');
    expect(WORKSPACE_PROFILE_TOOL_NAMES as readonly string[]).not.toContain('reset_sandbox');
  });

  // Drift guard: every tool the brain actually registers — across every curated kind — MUST have a
  // TOOL_SHAPES entry, or the SDK bridge would silently strip every argument that tool's handler reads
  // (a strict zod object drops unknown keys before the handler ever sees them).
  it('every buildTools()-registered tool (all kinds) has a TOOL_SHAPES entry', () => {
    for (const kind of [null, 'review', 'onboarding']) {
      const tools = manager.buildTools(fakeStimulus, kind);
      for (const name of Object.keys(tools)) {
        expect(TOOL_SHAPES, `brain tool "${name}" (kind=${kind}) must have a TOOL_SHAPES entry`).toHaveProperty(
          name,
        );
      }
    }
  });

  // Drift guard for the shared backend↔web contract (`ATLAS_HOST_BRIDGE_TOOLS` in @workspace/shared).
  // The host-bridge tool set is `Object.keys(buildTools())` MINUS the workspace-profile server's tools,
  // unioned across every session kind. This asserts the contract equals what the backend actually
  // registers — so adding/renaming/removing a host tool fails CI unless the contract (and, being an
  // exhaustive Record, the web label map) is updated in lockstep.
  it('ATLAS_HOST_BRIDGE_TOOLS matches the host-bridge tools registered across all session kinds', () => {
    const profile = new Set<string>(WORKSPACE_PROFILE_TOOL_NAMES);
    const registered = new Set<string>();
    for (const kind of [undefined, 'onboarding', 'review'] as const) {
      for (const name of Object.keys(manager.buildTools(fakeStimulus, kind))) {
        if (!profile.has(name)) registered.add(name);
      }
    }
    const contract = new Set<string>(ATLAS_HOST_BRIDGE_TOOLS);
    // Every registered host-bridge tool is in the contract (nothing unlisted)…
    for (const name of registered) {
      expect(contract.has(name), `registered host tool "${name}" missing from ATLAS_HOST_BRIDGE_TOOLS`).toBe(true);
    }
    // …and every contract entry is really registered (no stale name like the old `log_decision`).
    for (const name of contract) {
      expect(registered.has(name), `ATLAS_HOST_BRIDGE_TOOLS lists "${name}" but no kind registers it`).toBe(true);
    }
  });

  it('finish_onboarding: no repo diff → marks onboarded, does NOT ship a PR', async () => {
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({ worktreePath: '/wt' });
    (mockGit.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const tools = manager.buildTools(fakeStimulus, 'onboarding');

    const result = await tools['finish_onboarding']({
      summary: 'Boots green',
      verified: 'Brought up the API and worker via atlas-svc; both pass their health checks.',
    });

    expect(mockGit.hasChanges).toHaveBeenCalledWith('/wt');
    expect(mockLifecycle.markRepoOnboarded).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID);
    expect(mockShip.preShip).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, prOpened: false });
  });

  it('finish_onboarding: a real repo diff → marks onboarded AND hands the brain the open-PR instructions', async () => {
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktreePath: '/wt',
      branch: 'atlas/onboard-r',
    });
    (mockGit.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      repoId: PROJECT_ID,
      orgId: TEAM_ID,
    });
    (mockRepos.resolve as ReturnType<typeof vi.fn>).mockResolvedValue({
      owner: 'o',
      repo: 'r',
      defaultBranch: 'main',
      token: 't',
    });
    // Host gate passes; the brain opens the PR itself in-turn (no separate session). Reconciler latches it.
    (mockShip.preShip as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const tools = manager.buildTools(fakeStimulus, 'onboarding');

    const result = await tools['finish_onboarding']({
      summary: 'Boots green after a script fix',
      verified: 'Brought up the API and worker via atlas-svc; both pass their health checks.',
    });

    expect(mockLifecycle.markRepoOnboarded).toHaveBeenCalledWith(TEAM_ID, PROJECT_ID);
    // preShip is called positionally (job, repo, sandbox, notify) — no commit message: the host no longer
    // commits, so the brain commits its env-setup changes itself in the inline open-PR turn.
    expect(mockShip.preShip).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // prOpened is false at return (the PR opens inline afterward), and the message tells the brain to open it.
    expect(result).toMatchObject({ ok: true, prOpened: false });
    expect((result as { message: string }).message).toContain('gh pr create');
  });

  it('finish_onboarding NEVER throws on a markRepoOnboarded/git failure — warns and returns the real error', async () => {
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue({ worktreePath: '/wt' });
    (mockLifecycle.markRepoOnboarded as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const tools = manager.buildTools(fakeStimulus, 'onboarding');

    const result = await tools['finish_onboarding']({
      summary: 'Boots green',
      verified: 'Brought up the API and worker via atlas-svc; both pass their health checks.',
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('db down') });
    expect(mockShip.preShip).not.toHaveBeenCalled();
  });

  it('propose_mcp_servers + list_mcp_servers are available INCREMENTALLY on any thread (Workspace Profile upkeep)', () => {
    // MCP servers are a Workspace Profile dimension like skills/mounts — maintainable on every job, not just
    // onboarding (they ride the shared `intake` bundle).
    for (const kind of [undefined, 'onboarding', 'review'] as const) {
      const tools = manager.buildTools(fakeStimulus, kind);
      expect(tools['propose_mcp_servers']).toBeDefined();
      expect(tools['list_mcp_servers']).toBeDefined();
    }
  });

  it('propose_mcp_servers posts a proposal card + reports secret slots — writes NO server row', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['propose_mcp_servers']({
      servers: [
        {
          name: 'github',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: [{ name: 'Authorization', secret: true }],
          reason: 'repo hosted on GitHub',
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, proposed: ['github'] });
    expect(mockStore.openMcpProposal).toHaveBeenCalledTimes(1);
    const arg = (mockStore.openMcpProposal as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // The card carries the non-secret definition only — a secret slot is declared by NAME, no value.
    expect(arg.card.servers[0].headers).toEqual([{ name: 'Authorization', secret: true }]);
    expect(arg.card.scope).toBe('repo'); // defaults to repo scope (the owner-approved commit honors it)
    // The brain is told which slots to fill afterwards.
    expect((result as { message: string }).message).toContain('request_secret');
  });

  it('propose_mcp_servers carries scope:"org" onto the card when requested (org-wide registration)', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['propose_mcp_servers']({
      scope: 'org',
      servers: [{ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/sse' }],
    });
    expect(result).toMatchObject({ ok: true });
    const arg = (mockStore.openMcpProposal as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(arg.card.scope).toBe('org');
    expect((result as { message: string }).message).toContain('org-wide');
  });

  it('propose_mcp_servers rejects a reserved system name', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['propose_mcp_servers']({
      servers: [{ name: 'atlas-lsp-ts', transport: 'http', url: 'https://x' }],
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('reserved');
    expect(mockStore.openMcpProposal).not.toHaveBeenCalled();
  });

  it('propose_mcp_servers enforces the transport shape (http needs url, stdio needs command)', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const noUrl = await tools['propose_mcp_servers']({
      servers: [{ name: 'svc', transport: 'http' }],
    });
    expect(noUrl).toMatchObject({ ok: false });
    const noCommand = await tools['propose_mcp_servers']({
      servers: [{ name: 'svc', transport: 'stdio' }],
    });
    expect(noCommand).toMatchObject({ ok: false });
    expect(mockStore.openMcpProposal).not.toHaveBeenCalled();
  });

  it('propose_mcp_servers with authKind:"oauth" carries it onto the card + tells the brain the owner must Connect', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['propose_mcp_servers']({
      servers: [
        {
          name: 'jira',
          transport: 'sse',
          url: 'https://mcp.atlassian.com/v1/sse',
          authKind: 'oauth',
          oauth: { scope: 'read:jira-work', tokenAuthMethod: 'none' },
          reason: 'Issue tracking',
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, proposed: ['jira'] });
    const arg = (mockStore.openMcpProposal as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(arg.card.servers[0].authKind).toBe('oauth');
    expect(arg.card.servers[0].oauth).toEqual({ scope: 'read:jira-work', tokenAuthMethod: 'none' });
    const message = (result as { message: string }).message;
    expect(message).toContain('Connect');
    expect(message).toContain('jira');
  });

  it('propose_mcp_servers rejects oauth on a stdio transport (oauth is http/sse only)', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['propose_mcp_servers']({
      servers: [{ name: 'svc', transport: 'stdio', command: 'svc-mcp', authKind: 'oauth' }],
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('oauth');
    expect(mockStore.openMcpProposal).not.toHaveBeenCalled();
  });

  it('propose_mcp_servers rejects an oauth server that also declares a secret slot', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['propose_mcp_servers']({
      servers: [
        {
          name: 'svc',
          transport: 'http',
          url: 'https://x',
          authKind: 'oauth',
          headers: [{ name: 'Authorization', secret: true }],
        },
      ],
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('secret');
    expect(mockStore.openMcpProposal).not.toHaveBeenCalled();
  });

  it('request_secret with an mcp target opens a value-free card carrying the MCP slot (no path)', async () => {
    const tools = manager.buildTools(fakeStimulus, 'onboarding');
    const result = await tools['request_secret']({
      description: 'GitHub PAT for the GitHub MCP',
      mcp: { server: 'github', slot: 'header', key: 'Authorization' },
    });
    expect(result).toMatchObject({ ok: true });
    const arg = (mockStore.openSecretRequest as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(arg.card.mcp).toEqual({ server: 'github', slot: 'header', key: 'Authorization' });
    expect(arg.card.path).toBeUndefined();
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

  it('(e3) withdraw_question retracts an open card by id (and reports a no-op when it could not be withdrawn)', async () => {
    const tools = manager.buildTools(fakeStimulus);

    // Happy path: a still-open card is withdrawn (the store decrements the gate).
    (mockStore.withdrawQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: true });
    const ok = await tools['withdraw_question']({ questionId: 'q-123', reason: 'reworded' });
    expect(mockStore.withdrawQuestion).toHaveBeenCalledWith(THREAD_ID, 'q-123', 'reworded');
    expect(ok).toMatchObject({ ok: true, questionId: 'q-123' });

    // Missing questionId → refused before touching the store.
    (mockStore.withdrawQuestion as ReturnType<typeof vi.fn>).mockClear();
    const bad = await tools['withdraw_question']({});
    expect(bad).toMatchObject({ ok: false });
    expect(mockStore.withdrawQuestion).not.toHaveBeenCalled();

    // The operator answered first → the store reports no winner → the tool surfaces a no-op (don't re-ask).
    (mockStore.withdrawQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: false });
    const raced = await tools['withdraw_question']({ questionId: 'q-123' });
    expect(raced).toMatchObject({ ok: false });
  });

  it('(e4) buildTools() exposes withdraw_plan and withdraw_ship', () => {
    const tools = manager.buildTools(fakeStimulus);
    expect(tools['withdraw_plan']).toBeDefined();
    expect(tools['withdraw_ship']).toBeDefined();
  });

  it('(e5) withdraw_plan retracts a pending proposal — cancels the live handle + posts the notice; a non-awaiting job is a no-op', async () => {
    const tools = manager.buildTools(fakeStimulus);

    // Happy path: the store won the guarded flip → cancel the live handle + append the durable notice.
    (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: true });
    const ok = await tools['withdraw_plan']({ reason: 'pivoting' });
    expect(mockStore.withdrawPlan).toHaveBeenCalledWith(THREAD_ID, 'pivoting');
    expect(ok).toMatchObject({ ok: true });
    expect(mockApprovals.cancel as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      THREAD_ID,
      expect.any(String),
    );
    expect(mockStore.appendAtlasMessage).toHaveBeenCalledWith(THREAD_ID, expect.any(String));

    // No pending proposal → the store guard reports no winner → {ok:false}, no cancel/appendAtlasMessage.
    (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: false });
    (mockApprovals.cancel as ReturnType<typeof vi.fn>).mockClear();
    (mockStore.appendAtlasMessage as ReturnType<typeof vi.fn>).mockClear();
    const notPending = await tools['withdraw_plan']({});
    expect(notPending).toMatchObject({ ok: false });
    expect(mockApprovals.cancel).not.toHaveBeenCalled();
    expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
  });

  it('(e6) withdraw_ship PROPOSES amending (posts a card, does NOT retract); already-open and non-parked are no-ops', async () => {
    const tools = manager.buildTools(fakeStimulus);

    // Happy path: a fresh proposal is posted → ok, an Atlas "awaiting the operator" note is appended, and
    // the gate is NOT retracted (only the operator can release it).
    (mockDriverStore.openAmendProposal as ReturnType<typeof vi.fn>).mockResolvedValue('posted');
    const ok = await tools['withdraw_ship']({ reason: 'more polish' });
    expect(mockDriverStore.openAmendProposal).toHaveBeenCalledWith(THREAD_ID, 'more polish');
    expect(mockDriverStore.retractShip).not.toHaveBeenCalled();
    expect(ok).toMatchObject({ ok: true });
    expect(mockStore.appendAtlasMessage).toHaveBeenCalledWith(THREAD_ID, expect.any(String));

    // A proposal is already pending → {ok:false}, no duplicate note.
    (mockDriverStore.openAmendProposal as ReturnType<typeof vi.fn>).mockResolvedValue('already-open');
    (mockStore.appendAtlasMessage as ReturnType<typeof vi.fn>).mockClear();
    const alreadyOpen = await tools['withdraw_ship']({ reason: 'again' });
    expect(alreadyOpen).toMatchObject({ ok: false });
    expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();

    // Not parked at the ship gate → {ok:false}, no note.
    (mockDriverStore.openAmendProposal as ReturnType<typeof vi.fn>).mockResolvedValue('not-parked');
    (mockStore.appendAtlasMessage as ReturnType<typeof vi.fn>).mockClear();
    const notParked = await tools['withdraw_ship']({});
    expect(notParked).toMatchObject({ ok: false });
    expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
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

  it('(g1d) create_decision with no args returns a missing-arguments hint, not a field error', async () => {
    // When no payload reaches the host, the error must point at the missing arguments broadly, not mislead
    // with "decisionClass must be one of…".
    const tools = manager.buildTools(fakeStimulus);
    const result = (await tools['create_decision']({})) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/required fields/);
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

  it('(d) approve does NOT dispatch/implement synchronously — it fires the plan-approved JIT rule and buffers only the PASSIVE "approved" milestone (Thread 6)', async () => {
    const runningJob = { id: FAKE_JOB_ID, orgId: TEAM_ID, repoId: PROJECT_ID, baseBranch: 'main', kind: 'feature', title: 'rate limiting' };
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

    // NEITHER dispatcher.dispatch NOR runDirectBuild fires on approval — only the plan-approved JIT rule does.
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mockJit.fireLifecycle as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('plan-approved', {
      repoId: PROJECT_ID,
      jobId: FAKE_JOB_ID,
      orgId: TEAM_ID,
      buildPath: 'plan',
      baseBranch: 'main',
      decisionRecordId: FAKE_RECORD_ID,
    });
    const markerIds = (mockAwareness.appendMarker as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[1] as { id: string }).id,
    );
    expect(markerIds).toContain(`approved:${FAKE_RECORD_ID}`);
    expect(markerIds).not.toContain(`dispatched:${FAKE_RECORD_ID}`);
  });

  it('(d1) dispatch_build starts a direct build once and stamps the durable start marker first', async () => {
    const directJob = {
      id: THREAD_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      status: 'running',
      halt: null,
      buildPath: 'direct',
    };
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue(directJob);
    (mockStore.buildNotStarted as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const runDirect = vi
      .spyOn(manager as unknown as { runDirectBuild(s: unknown, j: unknown): Promise<void> }, 'runDirectBuild')
      .mockResolvedValue(undefined);
    const compact = vi
      .spyOn(manager as unknown as { enqueueCompaction(s: unknown): Promise<void> }, 'enqueueCompaction')
      .mockResolvedValue(undefined);

    const result = await manager.buildTools(fakeStimulus)['dispatch_build']({});

    expect(result).toMatchObject({ ok: true, jobId: THREAD_ID, message: 'Build started.' });
    expect(mockStore.buildNotStarted).toHaveBeenCalledWith(THREAD_ID);
    expect(mockStore.markDirectBuildStarted).toHaveBeenCalledWith(THREAD_ID);
    expect(runDirect).toHaveBeenCalledWith(fakeStimulus, directJob);
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(compact).toHaveBeenCalledWith(fakeStimulus);
    const markOrder = (mockStore.markDirectBuildStarted as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const runOrder = runDirect.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(runOrder);
  });

  it('(d1b) dispatch_build is idempotent for direct builds after the start marker is stamped', async () => {
    const directJob = {
      id: THREAD_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      status: 'running',
      halt: null,
      buildPath: 'direct',
    };
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue(directJob);
    (mockStore.buildNotStarted as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const runDirect = vi
      .spyOn(manager as unknown as { runDirectBuild(s: unknown, j: unknown): Promise<void> }, 'runDirectBuild')
      .mockResolvedValue(undefined);
    const compact = vi
      .spyOn(manager as unknown as { enqueueCompaction(s: unknown): Promise<void> }, 'enqueueCompaction')
      .mockResolvedValue(undefined);

    const result = await manager.buildTools(fakeStimulus)['dispatch_build']({});

    expect(result).toMatchObject({ ok: true, jobId: THREAD_ID, message: 'Build already started.' });
    expect(mockStore.markDirectBuildStarted).not.toHaveBeenCalled();
    expect(runDirect).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
  });

  it('(d2) resolveApprovalDurably: restart-safe approve (no live handle) fires the plan-approved JIT rule from durable state, NOT an immediate dispatch', async () => {
    const awaitingJob = {
      id: FAKE_JOB_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      baseBranch: 'main',
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
    expect(mockStore.approve).toHaveBeenCalledWith(FAKE_JOB_ID, FAKE_RECORD_ID, 'U-OP', 'plan');
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mockJit.fireLifecycle as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('plan-approved', {
      repoId: PROJECT_ID,
      jobId: FAKE_JOB_ID,
      orgId: TEAM_ID,
      buildPath: 'plan',
      baseBranch: 'main',
      decisionRecordId: FAKE_RECORD_ID,
    });
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

  it('(d4) actOnApprovalVerdict: store.approve returning null (withdrawn/superseded/stale click) posts the "withdrawn or updated" notice and does NOT dispatch', async () => {
    const job = { id: FAKE_JOB_ID, kind: 'feature', title: 'rate limiting' };
    (mockStore.approve as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: Promise.resolve({ verdict: 'approve', ruledBy: 'U-OP' }),
    });

    await manager.requestApprovalAndAct(
      fakeStimulus,
      job as never,
      FAKE_RECORD_ID,
      {
        jobId: FAKE_JOB_ID,
        decisionRecordId: FAKE_RECORD_ID,
        title: 'rate limiting',
        summary: 'x',
        decisions: [],
        threads: [],
      } as never,
    );

    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mockSurface.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'C',
      expect.stringContaining('withdrawn or updated'),
      expect.anything(),
    );
  });

  it("(d5) actOnApprovalVerdict prefers resolution.clickedDecisionRecordId (the version pin) over the handle's closure decisionRecordId for store.approve", async () => {
    const runningJob = { id: FAKE_JOB_ID, kind: 'feature', title: 'rate limiting' };
    (mockStore.approve as ReturnType<typeof vi.fn>).mockResolvedValue(runningJob);
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: Promise.resolve({
        verdict: 'approve',
        ruledBy: 'U-OP',
        clickedDecisionRecordId: 'rec-CLICKED',
      }),
    });

    await manager.requestApprovalAndAct(
      fakeStimulus,
      runningJob as never,
      FAKE_RECORD_ID, // the handle's closure record — must be IGNORED in favor of the clicked one
      {
        jobId: FAKE_JOB_ID,
        decisionRecordId: FAKE_RECORD_ID,
        title: 'rate limiting',
        summary: 'x',
        decisions: [],
        threads: [],
      } as never,
    );

    expect(mockStore.approve).toHaveBeenCalledWith(FAKE_JOB_ID, 'rec-CLICKED', 'U-OP', 'plan');
  });

  // ── Q2 (decision d1): the four approval-resolution acks render as calm System notices, never in
  //    Atlas's voice. Driven through the durable path, which funnels into the single actOnApprovalVerdict.
  describe('(d8) approval acks emit System notices, not appendAtlasMessage', () => {
    const awaitingJob = {
      id: FAKE_JOB_ID,
      orgId: TEAM_ID,
      repoId: PROJECT_ID,
      status: 'awaiting_approval',
      decisionRecordId: FAKE_RECORD_ID,
      kind: 'feature',
      title: 'rate limiting',
    };
    const setup = (threadTitles: string[]) => {
      (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
      (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue(awaitingJob);
      (mockStore.loadDecisionRecord as ReturnType<typeof vi.fn>).mockResolvedValue({ threadTitles });
      (mockStore.approve as ReturnType<typeof vi.fn>).mockResolvedValue({ ...awaitingJob, status: 'running' });
      vi.spyOn(manager as unknown as { enqueueCompaction(s: unknown): Promise<void> }, 'enqueueCompaction').mockResolvedValue(undefined);
      vi.spyOn(manager as unknown as { runDirectBuild(s: unknown, j: unknown): Promise<void> }, 'runDirectBuild').mockResolvedValue(undefined);
    };

    it('plan-approve → "Approved — checking the base branch before starting…" (System notice, not Atlas); fires plan-approved, not dispatch', async () => {
      setup(['Backend']); // non-empty ⇒ full plan
      await manager.resolveApprovalDurably(FAKE_JOB_ID, 'approve', 'U-OP');
      expect(mockStore.appendSystemNotice).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        'Approved — checking the base branch before starting…',
      );
      expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
      expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(mockJit.fireLifecycle as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'plan-approved',
        expect.objectContaining({ jobId: FAKE_JOB_ID, buildPath: 'plan' }),
      );
    });

    it('direct-approve → same "Approved — checking the base branch before starting…" notice (System notice, not Atlas); fires plan-approved, not runDirectBuild', async () => {
      setup([]); // empty threadTitles ⇒ direct build
      await manager.resolveApprovalDurably(FAKE_JOB_ID, 'approve', 'U-OP');
      expect(mockStore.appendSystemNotice).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        'Approved — checking the base branch before starting…',
      );
      expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
      expect(
        (manager as unknown as { runDirectBuild: ReturnType<typeof vi.fn> }).runDirectBuild,
      ).not.toHaveBeenCalled();
      expect(mockJit.fireLifecycle as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'plan-approved',
        expect.objectContaining({ jobId: FAKE_JOB_ID, buildPath: 'direct' }),
      );
    });

    it('request_changes (no note) → System notice ack, reopens planning, not Atlas', async () => {
      setup(['Backend']);
      // A note now goes to the brain via handleChatTurn (see (d5b)); the no-note path keeps the ack.
      await manager.resolveApprovalDurably(FAKE_JOB_ID, 'request_changes', 'U-OP');
      expect(mockStore.reopenPlanning).toHaveBeenCalledWith(FAKE_JOB_ID);
      expect(mockStore.appendSystemNotice).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        'Got it — back to the drawing board. What should change?',
      );
      expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
    });

    it('deny → "Understood — I\'ll drop this one." (System notice), cancels, not Atlas', async () => {
      setup(['Backend']);
      await manager.resolveApprovalDurably(FAKE_JOB_ID, 'deny', 'U-OP');
      expect(mockStore.cancel).toHaveBeenCalledWith(FAKE_JOB_ID);
      expect(mockStore.appendSystemNotice).toHaveBeenCalledWith(FAKE_JOB_ID, "Understood — I'll drop this one.");
      expect(mockStore.appendAtlasMessage).not.toHaveBeenCalled();
    });
  });

  it('(d5b) request_changes WITH a note delivers the note into the brain via handleChatTurn (not just an operator-facing ack)', async () => {
    const job = { id: FAKE_JOB_ID, kind: 'feature', title: 'rate limiting', orgId: TEAM_ID, repoId: PROJECT_ID };
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: Promise.resolve({
        verdict: 'request_changes',
        ruledBy: 'U-OP',
        note: 'Use Redis for the counter, not an in-memory map.',
      }),
    });
    const turn = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.requestApprovalAndAct(
      fakeStimulus,
      job as never,
      FAKE_RECORD_ID,
      {
        jobId: FAKE_JOB_ID,
        decisionRecordId: FAKE_RECORD_ID,
        title: 'rate limiting',
        summary: 'x',
        decisions: [],
        threads: [],
      } as never,
    );

    expect(mockStore.reopenPlanning).toHaveBeenCalledWith(FAKE_JOB_ID);
    expect(turn).toHaveBeenCalledOnce();
    const seed = turn.mock.calls[0][0] as ChatStimulus;
    expect(seed.jobId).toBe(FAKE_JOB_ID);
    expect(seed.body).toContain('Use Redis for the counter, not an in-memory map.');
    // The note case runs an engine turn instead of the canned "what should change?" ack.
    expect(mockSurface.post as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('drawing board'),
      expect.anything(),
    );
  });

  it('(d5c) request_changes WITHOUT a note keeps the operator ack and runs no engine turn', async () => {
    const job = { id: FAKE_JOB_ID, kind: 'feature', title: 'rate limiting', orgId: TEAM_ID, repoId: PROJECT_ID };
    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: Promise.resolve({ verdict: 'request_changes', ruledBy: 'U-OP' }),
    });
    const turn = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.requestApprovalAndAct(
      fakeStimulus,
      job as never,
      FAKE_RECORD_ID,
      {
        jobId: FAKE_JOB_ID,
        decisionRecordId: FAKE_RECORD_ID,
        title: 'rate limiting',
        summary: 'x',
        decisions: [],
        threads: [],
      } as never,
    );

    expect(mockStore.reopenPlanning).toHaveBeenCalledWith(FAKE_JOB_ID);
    expect(turn).not.toHaveBeenCalled();
    expect(mockSurface.post as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'C',
      expect.stringContaining('drawing board'),
      expect.anything(),
    );
  });

  // ── plan-gate auto-resolve (per-job opt-in): a job whose autoApproveMode APPROVES the plan gate
  //    ('plan' or 'both') drives the SAME resolution an operator's approve click would, the instant the
  //    card is posted — no human ever clicks it.
  describe('(auto-approve) requestApprovalAndAct — per-job auto-approve resolves the plan gate', () => {
    type ActOnApprovalVerdict = {
      actOnApprovalVerdict(...args: unknown[]): Promise<void>;
    };

    const card = {
      jobId: FAKE_JOB_ID,
      decisionRecordId: FAKE_RECORD_ID,
      title: 'rate limiting',
      summary: 'x',
      decisions: [],
      threads: [],
    } as never;

    it.each(['plan', 'both'] as const)(
      'resolves via the approvals seam with job.autoApproveBy as the approver (mode: %s)',
      async (mode) => {
        const job = {
          id: FAKE_JOB_ID,
          kind: 'feature',
          title: 'rate limiting',
          orgId: TEAM_ID,
          repoId: PROJECT_ID,
          autoApproveMode: mode,
          autoApproveBy: 'user-77',
        };
        (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
        (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
          jobId: FAKE_JOB_ID,
          verdict: Promise.resolve({ verdict: 'approve', ruledBy: 'user-77' }),
        });
        vi.spyOn(manager as unknown as ActOnApprovalVerdict, 'actOnApprovalVerdict').mockResolvedValue(undefined);

        await manager.requestApprovalAndAct(fakeStimulus, job as never, FAKE_RECORD_ID, card);

        expect(mockApprovals.resolve).toHaveBeenCalledWith(
          FAKE_JOB_ID,
          'approve',
          'user-77',
          undefined,
          FAKE_RECORD_ID,
        );
      },
    );

    it('falls back to store.ownerUserId when job.autoApproveBy is null', async () => {
      const job = {
        id: FAKE_JOB_ID,
        kind: 'feature',
        title: 'rate limiting',
        orgId: TEAM_ID,
        repoId: PROJECT_ID,
        autoApproveMode: 'plan',
        autoApproveBy: null,
      };
      (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
      (mockStore as unknown as { ownerUserId: ReturnType<typeof vi.fn> }).ownerUserId = vi
        .fn()
        .mockResolvedValue('owner-1');
      (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: FAKE_JOB_ID,
        verdict: Promise.resolve({ verdict: 'approve', ruledBy: 'owner-1' }),
      });
      vi.spyOn(manager as unknown as ActOnApprovalVerdict, 'actOnApprovalVerdict').mockResolvedValue(undefined);

      await manager.requestApprovalAndAct(fakeStimulus, job as never, FAKE_RECORD_ID, card);

      expect((mockStore as unknown as { ownerUserId: ReturnType<typeof vi.fn> }).ownerUserId).toHaveBeenCalledWith(
        TEAM_ID,
      );
      expect(mockApprovals.resolve).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        'approve',
        'owner-1',
        undefined,
        FAKE_RECORD_ID,
      );
    });

    it.each(['ship', 'off'] as const)(
      'does NOT auto-resolve when job.autoApproveMode does not approve the plan gate (mode: %s)',
      async (mode) => {
        const job = {
          id: FAKE_JOB_ID,
          kind: 'feature',
          title: 'rate limiting',
          orgId: TEAM_ID,
          repoId: PROJECT_ID,
          autoApproveMode: mode,
          autoApproveBy: null,
        };
        (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
        (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
          jobId: FAKE_JOB_ID,
          verdict: Promise.resolve({ verdict: 'deny', ruledBy: 'U-OP' }),
        });
        vi.spyOn(manager as unknown as ActOnApprovalVerdict, 'actOnApprovalVerdict').mockResolvedValue(undefined);

        await manager.requestApprovalAndAct(fakeStimulus, job as never, FAKE_RECORD_ID, card);

        expect(mockApprovals.resolve).not.toHaveBeenCalled();
      },
    );

    it('uses the fresh gate-time flag when auto-approve was enabled during the brain turn', async () => {
      const job = {
        id: FAKE_JOB_ID,
        kind: 'feature',
        title: 'rate limiting',
        orgId: TEAM_ID,
        repoId: PROJECT_ID,
        autoApproveMode: 'off',
        autoApproveBy: null,
      };
      (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
      (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...job,
        autoApproveMode: 'plan',
        autoApproveBy: 'user-fresh',
      });
      (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: FAKE_JOB_ID,
        verdict: Promise.resolve({ verdict: 'approve', ruledBy: 'user-fresh' }),
      });
      vi.spyOn(manager as unknown as ActOnApprovalVerdict, 'actOnApprovalVerdict').mockResolvedValue(undefined);

      await manager.requestApprovalAndAct(fakeStimulus, job as never, FAKE_RECORD_ID, card);

      expect(mockApprovals.resolve).toHaveBeenCalledWith(
        FAKE_JOB_ID,
        'approve',
        'user-fresh',
        undefined,
        FAKE_RECORD_ID,
      );
    });

    it('uses the fresh gate-time flag when auto-approve was disabled before the card posted', async () => {
      const job = {
        id: FAKE_JOB_ID,
        kind: 'feature',
        title: 'rate limiting',
        orgId: TEAM_ID,
        repoId: PROJECT_ID,
        autoApproveMode: 'both',
        autoApproveBy: 'user-stale',
      };
      (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({ channel: 'C', threadTs: 'ts' });
      (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...job,
        autoApproveMode: 'off',
      });
      (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        jobId: FAKE_JOB_ID,
        verdict: Promise.resolve({ verdict: 'deny', ruledBy: 'U-OP' }),
      });
      vi.spyOn(manager as unknown as ActOnApprovalVerdict, 'actOnApprovalVerdict').mockResolvedValue(undefined);

      await manager.requestApprovalAndAct(fakeStimulus, job as never, FAKE_RECORD_ID, card);

      expect(mockApprovals.resolve).not.toHaveBeenCalled();
    });
  });

  type PrepareRepropose = { prepareRepropose(jobId: string): Promise<{ refuse?: string }> };

  it('(d6) prepareRepropose refuses a job already past the approval gate, without touching withdrawPlan', async () => {
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'running',
    });

    const result = await (manager as unknown as PrepareRepropose).prepareRepropose(FAKE_JOB_ID);

    expect(result.refuse).toEqual(expect.any(String));
    expect(mockStore.withdrawPlan).not.toHaveBeenCalled();
  });

  it('(d7) prepareRepropose on an awaiting_approval job durably withdraws BEFORE dropping the live handle (order matters — closes the click window)', async () => {
    (mockStore.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: FAKE_JOB_ID,
      status: 'awaiting_approval',
      decisionRecordId: FAKE_RECORD_ID,
    });
    (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ withdrawn: true });

    const result = await (manager as unknown as PrepareRepropose).prepareRepropose(FAKE_JOB_ID);

    expect(result.refuse).toBeUndefined();
    expect(mockStore.withdrawPlan).toHaveBeenCalledWith(FAKE_JOB_ID, expect.any(String));
    expect(mockApprovals.cancel).toHaveBeenCalledWith(FAKE_JOB_ID, expect.any(String));
    const withdrawOrder = (mockStore.withdrawPlan as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const cancelOrder = (mockApprovals.cancel as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(withdrawOrder).toBeLessThan(cancelOrder);
  });

  // ── ADR 0004 Phase 3 — retry_thread tool + notifyThreadHalted wake ───────────────────────────────
  describe('ADR 0004 Phase 3 — halt wake + bounded fix', () => {
    const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;

    it('retry_thread delegates to redriveThread (which owns budget+validation) with the cap + guidance', async () => {
      fn(mockDispatcher.redriveThread).mockResolvedValue({ ok: true, attempt: 1 });
      const tools = manager.buildTools(fakeStimulus);
      const r = (await tools['retry_thread']({ threadId: 'th-x', guidance: 'return JSON' })) as {
        ok?: boolean;
        attempt?: number;
      };
      // The cap (HALT_FIX_ATTEMPT_CAP=2) is passed so the DRIVER claims budget only when it will re-drive.
      expect(mockDispatcher.redriveThread).toHaveBeenCalledWith(THREAD_ID, 'th-x', 'return JSON', 2);
      expect(r.ok).toBe(true);
      expect(r.attempt).toBe(1);
    });

    it('retry_thread escalates when redriveThread refuses (budget exhausted / active / wrong job)', async () => {
      fn(mockDispatcher.redriveThread).mockResolvedValue({
        ok: false,
        reason: 're-drive budget exhausted (2/2)',
      });
      const tools = manager.buildTools(fakeStimulus);
      const r = (await tools['retry_thread']({ threadId: 'th-x', guidance: 'again' })) as {
        ok?: boolean;
        reason?: string;
      };
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/budget exhausted|escalate/i);
    });

    it('retry_thread requires a threadId (never touches the driver)', async () => {
      const tools = manager.buildTools(fakeStimulus);
      const r = (await tools['retry_thread']({ guidance: 'x' })) as { ok?: boolean };
      expect(r.ok).toBe(false);
      expect(mockDispatcher.redriveThread).not.toHaveBeenCalled();
    });

    it('notifyThreadHalted wakes the brain with a TRUSTED seed carrying seedHaltWake + the fenced record', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'response format' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({
        status: 'blocked',
        summary: 'response format undecided',
        blocked: { reason: 'decision', detail: 'JSON vs plain text' },
      });
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadHalted('job1', 'th-x', 'blocked', 3);

      expect(spy).toHaveBeenCalledTimes(1);
      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.trust).toBe('trusted'); // NOT the untrusted event lane
      expect(stim.seed).toBe(true);
      expect(stim.seedHaltWake).toEqual({ threadId: 'th-x', gen: 3 });
      // Trusted framing OUTSIDE the fence, the model-authored record fenced INSIDE:
      expect(stim.body).toContain('build thread'); // framing
      expect(stim.body).toContain('retry_thread'); // the fix instruction
      expect(stim.body).toContain('JSON vs plain text'); // the record detail…
      expect(stim.body).toContain('<untrusted'); // …fenced as data (the <untrusted> tag)
      // The seed row's trusted framing is carried SEPARATELY from the fenced record (`label`) — the
      // untrusted pill's `fullBody` must never absorb the whole framed+fenced engine body.
      const seedRow = stim.seedRow as Extract<ChatStimulus['seedRow'], object>;
      expect(seedRow.kind).toBe('untrusted');
      expect(seedRow.framing).toBeTruthy();
      expect(seedRow.framing).toContain('retry_thread');
      expect(seedRow.label).not.toContain(seedRow.framing as string);
      spy.mockRestore();
    });

    it('notifyThreadHalted carries the transcript anchor (atlas-tx line + Leg) resolved from steps/legs', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'response format' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({
        status: 'blocked',
        summary: 'blocked on a missing secret',
        blocked: { reason: 'needs_env', detail: 'no API key' },
      });
      fn(mockDriverStore.resolveSessionAnchor).mockResolvedValue({ sessionId: 'sess-abc', legOrdinal: 2 });
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadHalted('job1', 'th-x', 'blocked', 1);

      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.body).toContain('atlas-tx show sess-abc');
      expect(stim.body).toContain('session sess-abc');
      expect(stim.body).toContain('Leg 2');
      // The forensic orientation bullet appears in the framing.
      expect(stim.body).toMatch(/READ THE HALTED LANE'S OWN TRANSCRIPT/);
      // The d2 autonomy boundary is stated explicitly.
      expect(stim.body).toMatch(/may NOT edit\/push code or ship without the operator/);
      spy.mockRestore();
    });

    it('notifyThreadHalted still carries the transcript anchor for an INCOMPLETE halt (null terminal record)', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'ran out of budget' });
      // The `incomplete` class ends WITHOUT a terminal record — the anchor must come from steps/legs, not term.
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue(null);
      fn(mockDriverStore.resolveSessionAnchor).mockResolvedValue({ sessionId: 'sess-inc' });
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadHalted('job1', 'th-x', 'incomplete', 0);

      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.body).toContain('atlas-tx show sess-inc');
      expect(stim.body).toContain('no terminal record');
      spy.mockRestore();
    });

    it('notifyThreadHalted is a no-op when the thread already shipped (record already done)', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'o', repoId: 'r' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 20, brief: 'shipped thread' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({ status: 'done', summary: 'shipped' });
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadHalted('job1', 'th-x', 'blocked', 0);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('notifyThreadHalted is a no-op when the job is gone', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue(null);
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadHalted('gone', 'th-x', 'blocked', 0);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ── Decision d1 — selective completion wake (FINAL + NOTABLE), mirrors the halt wake above ─────────
  describe('decision d1 — completion wake (final + notable)', () => {
    const fn = (m: unknown) => m as ReturnType<typeof vi.fn>;

    it('renderDoneDelivery states the d2 autonomy boundary + the atlas-tx pointer for BOTH reasons', () => {
      const thread = { id: 'th-x', ordinal: 10, brief: 'response format' };
      const anchor = { sessionId: 'sess-final', legOrdinal: 2 };
      const term = { status: 'done' as const, summary: 'shipped cleanly' };

      const finalBody = renderDoneDelivery(thread, 'final', term, anchor);
      expect(finalBody).toMatch(/may NOT edit\/push code or ship without the operator/);
      expect(finalBody).toMatch(/Ship it/);
      expect(finalBody).toContain('atlas-tx');
      // final ALSO triggers the ship-gate live-preview offer (the "Spin up preview" button prep)
      expect(finalBody).toMatch(/offer the operator a live preview/);
      expect(finalBody).toContain('Spin up preview');
      // final tells the brain to free the RAM the builders/master review left behind (backstop to the
      // deterministic per-thread driver teardown)
      expect(finalBody).toContain('atlas-svc stop-all');

      const notableBody = renderDoneDelivery(thread, 'notable', term, anchor);
      expect(notableBody).toMatch(/may NOT edit\/push code or ship without the operator/);
      expect(notableBody).toContain('atlas-tx show sess-final --errors');
      // notable does NOT carry the preview offer — that is a ship-gate concern only
      expect(notableBody).not.toMatch(/offer the operator a live preview/);
      expect(notableBody).not.toContain('LIVE PREVIEW AT THE SHIP GATE');
      // notable is a single-lane wake, not the whole-build parking — no fleet teardown instruction
      expect(notableBody).not.toContain('atlas-svc stop-all');
    });

    it('renderDoneDelivery (final) surfaces the master-review summary + per-thread gaps', () => {
      const thread = { id: 'th-final', ordinal: 99, brief: 'master review' };
      const term = { status: 'done' as const, summary: 'all lanes reviewed, no blockers' };
      const body = renderDoneDelivery(thread, 'final', term, undefined, [
        { brief: 'Backend — auth', gaps: ['rate limiting not load-tested'] },
      ]);
      expect(body).toContain('all lanes reviewed, no blockers');
      expect(body).toContain('Backend — auth');
      expect(body).toContain('rate limiting not load-tested');
      expect(body).toMatch(/Ship it/);
    });

    it('doneRecordBody projects summary + gaps + the transcript line (mirrors haltRecordBody)', () => {
      const term = {
        status: 'done' as const,
        summary: 'done with a caveat',
        gaps: ['auth edge case unverified'],
      };
      const projection = doneRecordBody(term, { sessionId: 'sess-1', legOrdinal: 3 });
      expect(projection).toContain('summary: done with a caveat');
      expect(projection).toContain('gaps:\n- auth edge case unverified');
      expect(projection).toContain('atlas-tx show sess-1 --errors');
      expect(projection).toContain('Leg 3');
    });

    it('notifyThreadDone wakes the brain with a TRUSTED seed carrying seedDoneWake + the fenced record (notable)', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'auth lane' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({
        status: 'done',
        summary: 'done, but left a gap',
        gaps: ['rate limiting not load-tested'],
      });
      fn(mockDriverStore.resolveSessionAnchor).mockResolvedValue({ sessionId: 'sess-notable' });
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadDone('job1', 'th-x', 'notable');

      expect(spy).toHaveBeenCalledTimes(1);
      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.trust).toBe('trusted');
      expect(stim.seed).toBe(true);
      expect(stim.seedDoneWake).toEqual({ threadId: 'th-x', reason: 'notable', gen: 1 });
      expect(stim.body).toContain('<untrusted');
      expect(stim.body).toContain('rate limiting not load-tested');
      expect(stim.body).toMatch(/may NOT edit\/push code or ship without the operator/);
      // The seed row's trusted framing rides separately from the fenced (untrusted) record `label`.
      const seedRow = stim.seedRow as Extract<ChatStimulus['seedRow'], object>;
      expect(seedRow.kind).toBe('untrusted');
      expect(seedRow.framing).toBeTruthy();
      expect(seedRow.framing).toMatch(/may NOT edit\/push code or ship without the operator/);
      expect(seedRow.label).not.toContain(seedRow.framing as string);
      spy.mockRestore();
    });

    it('notifyThreadDone (final) gathers per-thread gaps across the job for the master-review carrier', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-mr', ordinal: 99, brief: 'master review' });
      fn(mockDriverStore.getTerminalRecord).mockImplementation((id: string) =>
        Promise.resolve(
          id === 'th-mr'
            ? { status: 'done', summary: 'build reviewed and clean' }
            : { status: 'done', summary: 'ok', gaps: ['left a TODO'] },
        ),
      );
      fn(mockDriverStore.threadsForJob).mockResolvedValue([
        { id: 'th-mr', ordinal: 99, brief: 'master review' },
        { id: 'th-a', ordinal: 10, brief: 'Backend — auth' },
      ]);
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadDone('job1', 'th-mr', 'final');

      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.seedDoneWake).toEqual({ threadId: 'th-mr', reason: 'final', gen: 1 });
      expect(stim.body).toContain('build reviewed and clean');
      expect(stim.body).toContain('Backend — auth');
      expect(stim.body).toContain('left a TODO');
      spy.mockRestore();
    });

    it('notifyThreadDone is a no-op when the job is gone', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue(null);
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadDone('gone', 'th-x', 'notable');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('notifyThreadDone claims a gen and supersedes prior partials before delivering', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'auth lane' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({ status: 'done', summary: 'ok' });
      fn(mockDriverStore.claimDoneWakeGen).mockResolvedValue(3);
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadDone('job1', 'th-x', 'notable');

      expect(mockDriverStore.claimDoneWakeGen).toHaveBeenCalledWith('th-x');
      expect(mockDriverStore.supersedeDoneWakeMessages).toHaveBeenCalledWith('job1', 'th-x', 3);
      const stim = spy.mock.calls[0][0] as ChatStimulus;
      expect(stim.seedDoneWake).toEqual({ threadId: 'th-x', reason: 'notable', gen: 3 });
      spy.mockRestore();
    });

    it('notifyThreadDone no-ops (no delivery) when the wake is no longer owed (claim returns null)', async () => {
      fn(mockDriverStore.loadJob).mockResolvedValue({ id: 'job1', orgId: 'org1', repoId: 'repo1' });
      fn(mockDriverStore.getThread).mockResolvedValue({ id: 'th-x', ordinal: 10, brief: 'auth lane' });
      fn(mockDriverStore.getTerminalRecord).mockResolvedValue({ status: 'done', summary: 'ok' });
      fn(mockDriverStore.claimDoneWakeGen).mockResolvedValue(null); // already delivered by a racing sweep
      const spy = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);
      await manager.notifyThreadDone('job1', 'th-x', 'notable');

      expect(mockDriverStore.supersedeDoneWakeMessages).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      fn(mockDriverStore.claimDoneWakeGen).mockResolvedValue(1); // restore default for later tests
    });
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
    replyRoute: { surfaceId: 'web', jobRef: 'ts-stream-001' },
  };

  function makeManager(opts: {
    findSandbox?: unknown;
    ensureProvisioned?: ReturnType<typeof vi.fn>;
    run?: ReturnType<typeof vi.fn>;
    drainAndAdvance?: ReturnType<typeof vi.fn>;
    pendingCard?: unknown;
    wasReset?: boolean;
    sessionId?: string | null;
    resetContainer?: ReturnType<typeof vi.fn>;
    hardResetSandbox?: ReturnType<typeof vi.fn>;
    /** A live brain turn `runningBrainTurn` returns (drives the steer-into-live path); default none. */
    runningBrainTurn?: { turn_id: string } | null;
    /** The engine runner's `steer` mock (present → `steerIntoLiveBrainTurn` can fire). */
    steer?: ReturnType<typeof vi.fn>;
    /** Durable stimulus row resolved by input_ack/success-tail stamping; null models a legacy in-memory seed. */
    stimulusRow?: ChatStimulus | null;
  }) {
    const store = {
      route: vi.fn().mockResolvedValue({ channel: PROJECT_ID, threadTs: THREAD_ID }),
      appendBlock: vi.fn().mockResolvedValue(undefined),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      appendSystemNotice: vi.fn().mockResolvedValue(undefined),
      appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
      hasRecentSystemOperatorNotice: vi.fn().mockResolvedValue(false),
      appendSystemEvent: vi.fn().mockResolvedValue(undefined),
      updateCardMessage: vi.fn().mockResolvedValue(undefined),
      loadJob: vi.fn().mockResolvedValue({ kind: null }),
      // `pendingCard` simulates an open `ask_question` card (the live "currently-open card" reader).
      getQuestionCard: vi.fn().mockResolvedValue(opts.pendingCard ?? null),
      // The open-question surfacing prefix reads this each turn; default to "none open".
      openQuestionCards: vi.fn().mockResolvedValue([]),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      awaitingSecretId: vi.fn().mockResolvedValue(null),
      getSecretCard: vi.fn().mockResolvedValue(null),
      markSecretDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
      setActivity: vi.fn().mockResolvedValue(undefined),
      endTurnActivity: vi.fn().mockResolvedValue(undefined),
      setHalted: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrainStoreService;
    const lifecycle = {
      findSandbox: vi.fn().mockResolvedValue(opts.findSandbox ?? null),
      ensureProvisioned:
        opts.ensureProvisioned ?? vi.fn().mockResolvedValue({ id: 'sb-1', lifecycle: 'attached' }),
      ensureContainer: vi
        .fn()
        .mockResolvedValue({ sandbox: { worktreePath: '/wt', containerId: 'c1' }, wasReset: opts.wasReset ?? false }),
      resetContainer: opts.resetContainer ?? vi.fn().mockResolvedValue({ reset: true }),
      hardResetSandbox: opts.hardResetSandbox ?? vi.fn().mockResolvedValue({ reset: true }),
    } as unknown as JobLifecycleService;
    const git = {
      hasChanges: vi.fn().mockResolvedValue(false),
      currentBranch: vi.fn().mockResolvedValue(null),
      worktreeSafeToRecut: vi.fn().mockResolvedValue(true),
    } as unknown as LocalGitService;
    const surface = {
      post: vi.fn().mockResolvedValue('ts'),
      name: 'web',
    } as unknown as ChatSurface;
    const sandboxRows = {
      findOne: vi
        .fn()
        .mockResolvedValue({ job_id: THREAD_ID, org_id: TEAM_ID, session_id: opts.sessionId ?? null }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as Repository<JobSandboxEntity>;
    const steer = opts.steer ?? vi.fn().mockResolvedValue(undefined);
    const dockerRunner = {
      run: opts.run ?? vi.fn().mockResolvedValue({ result: '', sessionId: 's' }),
      steer,
      // The Redis runner's atomic in-process attach claim (single-winner turn-finalize fix): `reattachOne`
      // claims the slot before any await and releases on bail. Default the claim to won so the reattach
      // tests exercise the real re-attach body; `consumeClaim` feeds the error-path discard gate.
      tryClaimAttach: vi.fn(() => true),
      releaseAttach: vi.fn(),
      consumeClaim: vi.fn(() => undefined),
    } as unknown as EngineRunnerPort;
    const liveTurns = { push: vi.fn(), end: vi.fn(), snapshot: vi.fn(() => null) } as unknown as LiveTurnStore;
    // A REAL harness over the mock liveTurns + a mock durable sink — so the streaming spine is exercised
    // end-to-end through the brain (push/end + the durable blocks) exactly as in production.
    const blockSink = {
      appendBlock: vi.fn().mockResolvedValue(undefined),
      appendBlockOnce: vi.fn().mockResolvedValue(undefined),
    } as unknown as BlockSink;
    const taskSink = { applyTaskEvent: vi.fn().mockResolvedValue(undefined) } as unknown as TaskEventSink;
    const usage = { applyHarvest: vi.fn().mockResolvedValue(undefined) } as unknown as OauthUsageService;
    const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, taskSink, usage);
    const driverStore = {
      getPipelineState: vi.fn().mockResolvedValue({ status: 'no_job' }),
    } as unknown as DriverStoreService;
    const awareness = {
      appendMarker: vi.fn().mockResolvedValue(undefined),
      drainAndAdvance:
        opts.drainAndAdvance ?? vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
    } as unknown as PipelineAwarenessStore;
    const stimulusStore = {
      eligiblePendingChat: vi.fn().mockResolvedValue([]),
      leaseChatStimuli: vi.fn().mockResolvedValue(undefined),
      markChatDelivered: vi.fn().mockResolvedValue(undefined),
      undeliveredChatThreads: vi.fn().mockResolvedValue([]),
      resetChatLeases: vi.fn().mockResolvedValue(undefined),
      findChatStimulusById: vi.fn().mockResolvedValue(opts.stimulusRow ?? null),
    };

    const manager = new AgentSessionManager(
      store,
      driverStore,
      {} as unknown as MemoryStore,
      {} as unknown as DecisionApprovalService,
      lifecycle,
      dockerRunner,
      {
        listRunning: async () => [],
        runningBrainTurn: async () => opts.runningBrainTurn ?? null,
      } as never, // turnRegistry
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      surface,
      sandboxRows,
      { findOne: async () => null, update: async () => undefined, find: async () => [] } as never, // stimulusRows
      stimulusStore as never, // stimulusStore
      turnHarness,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      awareness,
      {} as unknown as TicketService,
      {} as unknown as JobDependencyService,
      { engineAuth: async () => undefined, openaiKey: async () => undefined } as unknown as CredentialResolver,
      { resolveForTurn: async () => [] } as never, // mcp (McpResolver)
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        list: async () => [],
        listForRepo: async () => [],
        read: async () => null,
      } as unknown as WorkspaceSecretFileStore,
      {
        listMounts: async () => [],
        upsertMount: async () => undefined,
      } as unknown as WorkspaceConfigStore,
      git,
      { generate: () => 'SYSTEM' } as never, // prompts (PromptService)
      { register: () => undefined } as never, // threadInput (ThreadInputService)
      { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (OauthUsageService)
    );
    return {
      manager,
      store,
      lifecycle,
      git,
      surface,
      sandboxRows,
      dockerRunner,
      liveTurns,
      blockSink,
      awareness,
      turnHarness,
      stimulusStore,
    };
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

    // A fresh turn clears any previous halted flag once it starts.
    expect(store.setHalted as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(THREAD_ID, false);

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

    // The "setting up…" line is HARNESS narration (a quiet appendSystemEvent pill), never a fake Atlas
    // reply — and the final engine reply is persisted via the durable block sink above, not a separate
    // say(), so appendAtlasMessage is never called in this flow at all.
    expect((store.appendAtlasMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((store.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('Setting up');
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
    expect((store.setHalted as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [THREAD_ID, false],
      [THREAD_ID, true],
    ]);
  });

  it('routes a GENERIC in-sandbox engine failure to a system→operator notice, showing the TRUE error verbatim (no narrative wrapper)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const { manager, store, surface } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    // Persisted via the system→operator seam (own box), NOT as an Atlas message.
    expect(store.appendSystemOperatorMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(store.appendAtlasMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const notice = (surface.post as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[2] as { meta?: { source?: string } } | undefined)?.meta?.source === 'system_operator',
    );
    expect(notice).toBeTruthy();
    // No "I ran into an error — please try again" narrative wrapper — just the true error, verbatim.
    expect(String(notice![1])).toContain('boom');
    expect(String(notice![1])).not.toContain('try again');
    expect(String(notice![1])).not.toContain('I ran into an error');
    // Marked retryable — the web renders a "Resume" button (POST …/retry-turn) on this box.
    expect((notice![2] as { meta?: { retryable?: boolean } }).meta?.retryable).toBe(true);
    expect(
      (store.appendSystemOperatorMessage as ReturnType<typeof vi.fn>).mock.calls[0][2],
    ).toMatchObject({ retryable: true });
    expect((store.setHalted as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [THREAD_ID, false],
      [THREAD_ID, true],
    ]);
  });

  it('SUPPRESSES a duplicate system→operator notice — a persistent limit fails every re-driven turn identically', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom: monthly spend limit'));
    const { manager, store, surface } = makeManager({ run });
    // An identical notice already landed on this thread moments ago (a prior turn hit the same wall).
    (store.hasRecentSystemOperatorNotice as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await manager.handleChatTurn(stimulus);

    // Neither the durable row nor the live box is re-posted — the operator already has one.
    expect(store.appendSystemOperatorMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const notice = (surface.post as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[2] as { meta?: { source?: string } } | undefined)?.meta?.source === 'system_operator',
    );
    expect(notice).toBeUndefined();
    // A Resume/new turn clears `halted` at start, so a deduped repeated failure must re-assert it even
    // though no second box is written.
    expect((store.setHalted as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [THREAD_ID, false],
      [THREAD_ID, true],
    ]);
  });

  it('does NOT mark the unresumable-session notice as retryable (retrying truly cannot help)', async () => {
    const run = vi.fn().mockRejectedValue(
      new Error(`${UNRESUMABLE_SESSION_MARKER}: engine session ghost not found — cannot resume`),
    );
    const { manager, surface } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    const notice = (surface.post as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[2] as { meta?: { source?: string } } | undefined)?.meta?.source === 'system_operator',
    );
    expect(notice).toBeTruthy();
    expect((notice![2] as { meta?: { retryable?: boolean } }).meta?.retryable).toBeUndefined();
  });

  it('narrates the FIRST-provision + container-attach stages via appendSystemEvent (a quiet pill), not a fake Atlas reply', async () => {
    let provisionedMilestone: ((stage: string) => void) | undefined;
    let containerMilestone: ((stage: string) => void) | undefined;
    const ensureProvisioned = vi.fn(async (_jobId: string, _orgId: string, onMilestone?: (s: string) => void) => {
      provisionedMilestone = onMilestone;
      onMilestone?.('image_build');
      return { id: 'sb-1', lifecycle: 'attached' };
    });
    const { manager, store, lifecycle } = makeManager({ ensureProvisioned });
    // Capture ensureContainer's own onMilestone the same way, then invoke it manually.
    (lifecycle.ensureContainer as ReturnType<typeof vi.fn>).mockImplementation(
      async (_jobId: string, _orgId: string, onMilestone?: (s: string) => void) => {
        containerMilestone = onMilestone;
        onMilestone?.('container_create');
        return { sandbox: { worktreePath: '/wt', containerId: 'c1' }, wasReset: false };
      },
    );

    await manager.handleChatTurn(stimulus);

    expect(provisionedMilestone).toBeTypeOf('function');
    expect(containerMilestone).toBeTypeOf('function');
    const events = (store.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
    expect(events.some((t) => /building the sandbox image/i.test(t))).toBe(true);
    expect(events.some((t) => /preparing this thread.s workspace container/i.test(t))).toBe(true);
    // Never a fake Atlas chat reply for any of this narration.
    expect(store.appendAtlasMessage as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
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

  it('steers a queued durable question-answer into a LIVE brain turn and stamps only on input_ack', async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 's' });
    const answerSeed: ChatStimulus = {
      ...stimulus,
      id: 'seed-ans-1',
      body: '<system_notice>The operator answered your question "toolchain?": napi-rs</system_notice>',
      author: { id: 'U-SYSTEM', displayName: 'System' },
      seed: true,
      seedQuestionId: 'q-1',
    };
    const { manager, dockerRunner, store, stimulusStore } = makeManager({
      findSandbox: { worktreePath: '/wt' },
      run,
      steer,
      runningBrainTurn: { turn_id: 'T-live' },
      stimulusRow: answerSeed,
      // the answered, not-yet-delivered card the seed carries
      pendingCard: { type: 'question_card', answer: 'napi-rs', deliveredAt: null },
    });

    await manager.handleChatTurn(answerSeed);

    // Steered into the live turn; NO second engine turn kicked.
    expect(steer).toHaveBeenCalledWith('T-live', 'seed-ans-1', answerSeed.body);
    expect(dockerRunner.run).not.toHaveBeenCalled();
    // A bare steer is not consumption; the durable row + card are stamped only on the engine input_ack.
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();

    const stamp = (manager as never as { stampInputAck: (e: EngineEvent) => void }).stampInputAck.bind(manager);
    stamp({ kind: 'input_ack', id: 'seed-ans-1' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(store.markQuestionDelivered).toHaveBeenCalledWith(THREAD_ID, 'q-1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('seed-ans-1');
  });

  it('does NOT steer a reset-verify seed — it runs its own (guarded) turn even when a turn is live', async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const { manager } = makeManager({
      findSandbox: { worktreePath: '/wt' },
      steer,
      runningBrainTurn: { turn_id: 'T-live' },
    });

    const resetVerify: ChatStimulus = {
      ...stimulus,
      id: 'seed-reset-1',
      author: { id: 'U-SYSTEM', displayName: 'System' },
      seed: true,
      seedResetVerify: true,
    };
    await manager.handleChatTurn(resetVerify);

    // Reset-verify is exempt from the steer-into-live shortcut (its cold-attach semantics are load-bearing).
    expect(steer).not.toHaveBeenCalled();
  });

  it('with NO live turn, a question-answer seed runs its own turn (steer path is skipped)', async () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 's' });
    const { manager, dockerRunner } = makeManager({
      findSandbox: { worktreePath: '/wt' },
      run,
      steer,
      runningBrainTurn: null,
      pendingCard: { type: 'question_card', answer: 'napi-rs', deliveredAt: null },
    });

    await manager.handleChatTurn({
      ...stimulus,
      id: 'seed-ans-2',
      seed: true,
      seedQuestionId: 'q-2',
    });

    expect(steer).not.toHaveBeenCalled();
    expect(dockerRunner.run).toHaveBeenCalledTimes(1);
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

  it('a closed sandbox posts the "thread is closed" notice ONCE and MARKS the message delivered (kills the 2-min spam)', async () => {
    // ensureProvisioned → null means the sandbox is torn down (lifecycle=closed) and NOT revived (a
    // non-operator seed, or a genuinely un-provisionable job). The message must be stamped delivered via
    // onRegistered — else the undelivered-chat sweep re-posts this identical notice every lease cycle.
    const ensureProvisioned = vi.fn().mockResolvedValue(null);
    const { manager, surface } = makeManager({ findSandbox: { worktreePath: '/wt' }, ensureProvisioned });
    const onRegistered = vi.fn();

    await (
      manager as unknown as {
        runChatTurn: (s: ChatStimulus, o: { onRegistered: () => void }) => Promise<void>;
      }
    ).runChatTurn(stimulus, { onRegistered });

    const closedPosts = (surface.post as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[1]).includes('This thread is closed'),
    );
    expect(closedPosts).toHaveLength(1); // posted once, not spammed
    expect(onRegistered).toHaveBeenCalledTimes(1); // marked delivered → the sweep can't re-drive it
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

    // runDirectBuild / startFollowUpJob stamp author.id = 'atlas' — these must not consume the buffer.
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
    const deliveryStimulus: ChatStimulus = {
      ...stimulus,
      id: 'seed-deliver-row',
      seed: true,
      seedQuestionId: 'q-deliver',
    };
    const { manager, store, stimulusStore } = makeManager({
      pendingCard: { type: 'question_card', answer: 'dynamic', deliveredAt: null },
      stimulusRow: deliveryStimulus,
    });

    await manager.handleChatTurn(deliveryStimulus);

    expect(store.markQuestionDelivered).toHaveBeenCalledWith(THREAD_ID, 'q-deliver');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('seed-deliver-row');
  });

  it('a normal operator turn (no seedQuestionId) never marks a card delivered', async () => {
    const { manager, store } = makeManager({
      pendingCard: { type: 'question_card', answer: 'dynamic', deliveredAt: null },
    });

    await manager.handleChatTurn(stimulus);

    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
  });

  it('boot re-attach of an ONBOARDING turn rebuilds the CURATED onboarding tool map (finish_onboarding dispatchable)', async () => {
    // The regression: `reattachOne` rebuilt the host dispatch map without the onboarding flag, so after a
    // mid-turn restart the container (still declaring the onboarding toolset from the original kick) got
    // "Unknown tool: 'finish_onboarding'" back when the session finally tried to conclude.
    const { manager, store, dockerRunner } = makeManager({});
    (store.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'onboarding' });
    const reattach = vi.fn().mockResolvedValue({ result: 'done', sessionId: 's-re' });
    (dockerRunner as { reattach?: unknown }).reattach = reattach;

    await (manager as unknown as { reattachOne(row: unknown): Promise<void> }).reattachOne({
      turn_id: 'turn-re-1',
      container_id: 'c-re-1',
      org_id: TEAM_ID,
      job_id: THREAD_ID,
      channel: PROJECT_ID,
      ctx: { repoId: PROJECT_ID, author: { id: 'U-OP', displayName: 'Operator' }, body: 'Begin onboarding' },
    });

    expect(reattach).toHaveBeenCalledOnce();
    const opts = reattach.mock.calls[0][2] as { toolBridge: { tools: Record<string, unknown> } };
    const names = Object.keys(opts.toolBridge.tools);
    expect(names).toContain('finish_onboarding');
    expect(names).toContain('write_workspace_config');
    expect(names).not.toContain('propose_plan');
  });

  it('reattachOne resets the live-turn lane (channel, jobId) BEFORE the harness/replay', async () => {
    // Clearing the stranded lane before the '0-0' replay is what rebuilds a clean buffer (no persistent
    // multiple-cursor state). It must run before create/reattach so the replay repopulates from empty.
    const { manager, store, dockerRunner, turnHarness } = makeManager({});
    (store.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: null });
    const reattach = vi.fn().mockResolvedValue({ result: 'done', sessionId: 's-re' });
    (dockerRunner as { reattach?: unknown }).reattach = reattach;
    const resetLane = vi.spyOn(turnHarness, 'resetLane');

    await (manager as unknown as { reattachOne(row: unknown): Promise<void> }).reattachOne({
      turn_id: 'turn-re-reset',
      container_id: 'c-re-reset',
      org_id: TEAM_ID,
      job_id: THREAD_ID,
      channel: PROJECT_ID,
      ctx: { repoId: PROJECT_ID, author: { id: 'U-OP', displayName: 'Operator' }, body: 'Keep going' },
    });

    expect(resetLane).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID);
    // Ordering: the reset fires before the '0-0' replay so the replay rebuilds onto an empty lane.
    expect(resetLane.mock.invocationCallOrder[0]).toBeLessThan(reattach.mock.invocationCallOrder[0]);
  });

  it('reattachOne still runs when the runner lacks Redis-only attach claim helpers', async () => {
    const { manager, store, dockerRunner } = makeManager({});
    delete (dockerRunner as { tryClaimAttach?: unknown }).tryClaimAttach;
    delete (dockerRunner as { releaseAttach?: unknown }).releaseAttach;
    (store.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: null });
    const reattach = vi.fn().mockResolvedValue({ result: 'done', sessionId: 's-re' });
    (dockerRunner as { reattach?: unknown }).reattach = reattach;

    await (manager as unknown as { reattachOne(row: unknown): Promise<void> }).reattachOne({
      turn_id: 'turn-re-no-claim-helper',
      container_id: 'c-re-no-claim-helper',
      org_id: TEAM_ID,
      job_id: THREAD_ID,
      channel: PROJECT_ID,
      ctx: { repoId: PROJECT_ID, author: { id: 'U-OP', displayName: 'Operator' }, body: 'Keep going' },
    });

    expect(reattach).toHaveBeenCalledOnce();
  });

  it('boot re-attach of a NORMAL turn rebuilds the full build toolset (no onboarding curation)', async () => {
    const { manager, store, dockerRunner } = makeManager({});
    (store.loadJob as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: null });
    const reattach = vi.fn().mockResolvedValue({ result: 'done', sessionId: 's-re' });
    (dockerRunner as { reattach?: unknown }).reattach = reattach;

    await (manager as unknown as { reattachOne(row: unknown): Promise<void> }).reattachOne({
      turn_id: 'turn-re-2',
      container_id: 'c-re-2',
      org_id: TEAM_ID,
      job_id: THREAD_ID,
      channel: PROJECT_ID,
      ctx: { repoId: PROJECT_ID, author: { id: 'U-OP', displayName: 'Operator' }, body: 'Keep going' },
    });

    const opts = reattach.mock.calls[0][2] as { toolBridge: { tools: Record<string, unknown> } };
    const names = Object.keys(opts.toolBridge.tools);
    expect(names).toContain('propose_plan');
    expect(names).toContain('review_plan');
    expect(names).not.toContain('finish_onboarding');
  });

  it('a NORMAL (non-onboarding) thread has the SAME on-the-fly capabilities as the ceremony — secrets, files, AND config', () => {
    // The ceremony and an ordinary build thread share identical onboarding capabilities: the ceremony just
    // does it all up front, a regular thread does it incrementally whenever it hits the same friction.
    // `finish_onboarding` is the one ceremony-only exception (it stamps onboarded_at + opens the dedicated
    // config PR — a regular thread's own build already commits atlas.json as part of its own PR).
    const { manager } = makeManager({});
    const tools = manager.buildTools(stimulus);
    expect(tools.request_secret).toBeDefined();
    expect(tools.request_file).toBeDefined();
    expect(tools.derive_secret).toBeDefined();
    expect(tools.write_workspace_config).toBeDefined();
    expect(tools.finish_onboarding).toBeUndefined();
  });

  // ── reset_sandbox: recreate the container to prove the environment cold-boots ────────────────────
  describe('reset_sandbox', () => {
    const KEY = `${TEAM_ID}:${THREAD_ID}`;

    it('is available to BOTH normal and onboarding threads and flags a reset (posting the operator cue mid-turn)', async () => {
      const { manager, store } = makeManager({});
      expect(manager.buildTools(stimulus).reset_sandbox).toBeDefined();
      expect(manager.buildTools(stimulus, 'onboarding').reset_sandbox).toBeDefined();

      const res = (await manager.buildTools(stimulus).reset_sandbox({ reason: 'verify mounts' })) as Record<
        string,
        unknown
      >;
      expect(res).toMatchObject({ ok: true, willReset: true });
      // The tool only FLAGS the reset (the tail tears down) — nothing was recreated during the call.
      expect((manager as unknown as { resetRequests: Map<string, unknown> }).resetRequests.get(KEY)).toEqual({
        reason: 'verify mounts',
      });
      // The visible cue is posted HERE (mid-turn) so it lands on THIS turn's /messages reconcile — a
      // tail-posted pill would miss it (turn_end already fired). See the tool comment.
      expect(
        (store.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls.some((c) => /reset/i.test(String(c[1]))),
      ).toBe(true);
    });

    it('refuses a 4th consecutive reset (loop guard) so a broken setup cannot spin forever', async () => {
      const { manager } = makeManager({});
      const tool = manager.buildTools(stimulus).reset_sandbox;
      for (let i = 0; i < 3; i++) {
        expect(await tool({ reason: 'again' })).toMatchObject({ ok: true, willReset: true });
      }
      const refused = (await tool({ reason: 'again' })) as Record<string, unknown>;
      expect(refused.ok).toBe(false);
      expect(String(refused.reason)).toContain('3 times');
    });

    it('an operator turn clears the consecutive-reset counter (so operator-driven resets never trip the guard)', async () => {
      const { manager } = makeManager({});
      const counters = (manager as unknown as { consecutiveResets: Map<string, number> }).consecutiveResets;
      counters.set(KEY, 3);
      await manager.handleChatTurn(stimulus); // stimulus.author.id = 'U-OP' → operator
      expect(counters.has(KEY)).toBe(false);
    });

    it('the turn tail tears the container down and kicks a verify continuation when a reset was requested', async () => {
      const resetContainer = vi.fn().mockResolvedValue({ reset: true });
      const { manager, lifecycle } = makeManager({ resetContainer });
      (manager as unknown as { resetRequests: Map<string, unknown> }).resetRequests.set(KEY, { reason: 'verify' });
      const kick = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

      await (manager as unknown as { maybeHonorSandboxReset: (s: ChatStimulus) => Promise<void> }).maybeHonorSandboxReset(
        stimulus,
      );

      expect(lifecycle.resetContainer as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(THREAD_ID, TEAM_ID);
      // The verify instruction is owed to the first cold-attached turn…
      expect((manager as unknown as { pendingResetVerify: Set<string> }).pendingResetVerify.has(KEY)).toBe(true);
      // …the request is consumed (never honored twice)…
      expect((manager as unknown as { resetRequests: Map<string, unknown> }).resetRequests.has(KEY)).toBe(false);
      // …and exactly one synthetic verify continuation is kicked.
      expect(kick).toHaveBeenCalledTimes(1);
      const seed = kick.mock.calls[0][0] as ChatStimulus;
      expect(seed.seed).toBe(true);
      expect(seed.seedResetVerify).toBe(true);
    });

    it('the turn tail does NOT reset or kick when a build is running in the container (busy guard)', async () => {
      const resetContainer = vi.fn().mockResolvedValue({ reset: false, reason: 'busy' });
      const { manager, store } = makeManager({ resetContainer });
      (manager as unknown as { resetRequests: Map<string, unknown> }).resetRequests.set(KEY, { reason: 'verify' });
      const kick = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

      await (manager as unknown as { maybeHonorSandboxReset: (s: ChatStimulus) => Promise<void> }).maybeHonorSandboxReset(
        stimulus,
      );

      expect(kick).not.toHaveBeenCalled();
      expect((manager as unknown as { pendingResetVerify: Set<string> }).pendingResetVerify.has(KEY)).toBe(false);
      expect(
        (store.appendSystemEvent as ReturnType<typeof vi.fn>).mock.calls.some((c) => /skipped/i.test(String(c[1]))),
      ).toBe(true);
    });

    it('the turn tail is a no-op when no reset was requested', async () => {
      const resetContainer = vi.fn();
      const { manager } = makeManager({ resetContainer });
      await (manager as unknown as { maybeHonorSandboxReset: (s: ChatStimulus) => Promise<void> }).maybeHonorSandboxReset(
        stimulus,
      );
      expect(resetContainer).not.toHaveBeenCalled();
    });

    // ── hard reset ({ hard:true }) — two-call confirm + dirty/unpushed refusal ──────────────────────
    const resetReq = (m: AgentSessionManager) =>
      (m as unknown as { resetRequests: Map<string, { reason: string; hard?: boolean }> }).resetRequests;
    const pendingHard = (m: AgentSessionManager) =>
      (m as unknown as { pendingHardReset: Set<string> }).pendingHardReset;

    it('hard reset: FIRST call arms + returns a notice and does NOT queue the reset', async () => {
      const { manager } = makeManager({ findSandbox: { branch: 'atlas/feature', worktreePath: '/wt' } });
      const res = (await manager.buildTools(stimulus).reset_sandbox({ reason: 'prove stack', hard: true })) as Record<
        string,
        unknown
      >;
      expect(res).toMatchObject({ ok: true, willReset: false, confirmRequired: true });
      expect(String(res.message)).toMatch(/HARD RESET/);
      // Armed but NOT queued — nothing for the tail to honor yet.
      expect(pendingHard(manager).has(KEY)).toBe(true);
      expect(resetReq(manager).has(KEY)).toBe(false);
    });

    it('hard reset: SECOND call queues the reset marked `hard` and disarms the confirm', async () => {
      const { manager } = makeManager({ findSandbox: { branch: 'atlas/feature', worktreePath: '/wt' } });
      const tool = manager.buildTools(stimulus).reset_sandbox;
      await tool({ reason: 'prove stack', hard: true }); // arm
      const res = (await tool({ reason: 'prove stack', hard: true })) as Record<string, unknown>;
      expect(res).toMatchObject({ ok: true, willReset: true });
      expect(resetReq(manager).get(KEY)).toEqual({ reason: 'prove stack', hard: true });
      expect(pendingHard(manager).has(KEY)).toBe(false);
    });

    it('hard reset: REFUSES on a dirty tree (host never commits to rescue work)', async () => {
      const { manager, git } = makeManager({ findSandbox: { branch: 'atlas/feature', worktreePath: '/wt' } });
      (git.hasChanges as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const res = (await manager.buildTools(stimulus).reset_sandbox({ reason: 'x', hard: true })) as Record<
        string,
        unknown
      >;
      expect(res.ok).toBe(false);
      expect(String(res.reason)).toMatch(/uncommitted changes/);
      expect(pendingHard(manager).has(KEY)).toBe(false); // not armed
    });

    it('hard reset: REFUSES a full clone with unpushed commits (would be lost on re-cut)', async () => {
      const { manager, git } = makeManager({ findSandbox: { branch: 'atlas/feature', worktreePath: '/wt' } });
      (git.worktreeSafeToRecut as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = (await manager.buildTools(stimulus).reset_sandbox({ reason: 'x', hard: true })) as Record<
        string,
        unknown
      >;
      expect(res.ok).toBe(false);
      expect(String(res.reason)).toMatch(/not yet pushed/);
    });

    it('the turn tail honors a HARD reset via hardResetSandbox (not resetContainer)', async () => {
      const hardResetSandbox = vi.fn().mockResolvedValue({ reset: true });
      const resetContainer = vi.fn();
      const { manager, lifecycle } = makeManager({ hardResetSandbox, resetContainer });
      resetReq(manager).set(KEY, { reason: 'prove stack', hard: true });
      vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

      await (manager as unknown as { maybeHonorSandboxReset: (s: ChatStimulus) => Promise<void> }).maybeHonorSandboxReset(
        stimulus,
      );

      expect(lifecycle.hardResetSandbox as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(THREAD_ID, TEAM_ID);
      expect(lifecycle.resetContainer as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect((manager as unknown as { pendingResetVerify: Set<string> }).pendingResetVerify.has(KEY)).toBe(true);
    });

    it('folds the verify instruction into the reset-notice on the FIRST cold-attached turn (e.g. a queued operator turn)', async () => {
      const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 's' });
      const { manager, dockerRunner } = makeManager({ run, wasReset: true, sessionId: 'sess-prior' });
      (manager as unknown as { pendingResetVerify: Set<string> }).pendingResetVerify.add(KEY);

      await manager.handleChatTurn(stimulus); // an operator turn that happened to be queued behind the reset

      const runArgs = (dockerRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
      expect(runArgs.task).toContain('cold-boot'); // RESET_VERIFY_TEXT rode the notice
      expect(runArgs.task).toContain('Explain the build step'); // the operator's own message is preserved after it
      // Consumed — a later synthetic continuation won't re-issue it.
      expect((manager as unknown as { pendingResetVerify: Set<string> }).pendingResetVerify.has(KEY)).toBe(false);
    });

    it('the reset-verify continuation is a NO-OP when the notice was already consumed by an earlier turn', async () => {
      const run = vi.fn().mockResolvedValue({ result: 'ok', sessionId: 's' });
      const { manager, dockerRunner } = makeManager({ run });
      // pendingResetVerify is NOT set → an earlier turn already cold-attached and consumed the notice.
      const seed: ChatStimulus = {
        ...stimulus,
        author: { id: 'atlas', displayName: 'Atlas' },
        seed: true,
        seedResetVerify: true,
      };

      await manager.handleChatTurn(seed);

      expect(dockerRunner.run).not.toHaveBeenCalled(); // guarded out — no redundant turn on the warm box
    });
  });
});

describe('AgentSessionManager — create_job tool (independent follow-up)', () => {
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
    replyRoute: { surfaceId: 'web', jobRef: THREAD },
  };

  function makeManager(storeOverrides: Record<string, unknown> = {}) {
    const store = {
      loadJob: vi.fn().mockResolvedValue({ baseBranch: 'main', title: 'Parent job' }),
      createFollowUpJob: vi.fn().mockResolvedValue('th-followup'),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      appendSystemNotice: vi.fn().mockResolvedValue(undefined),
      getQuestionCard: vi.fn().mockResolvedValue(null),
      openQuestionCards: vi.fn().mockResolvedValue([]),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      awaitingSecretId: vi.fn().mockResolvedValue(null),
      getSecretCard: vi.fn().mockResolvedValue(null),
      markSecretDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
      setActivity: vi.fn().mockResolvedValue(undefined),
      endTurnActivity: vi.fn().mockResolvedValue(undefined),
      setHalted: vi.fn().mockResolvedValue(undefined),
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
      {
        eligiblePendingChat: async () => [],
        leaseChatStimuli: async () => undefined,
        markChatDelivered: async () => undefined,
        undeliveredChatThreads: async () => [],
        resetChatLeases: async () => undefined,
        findChatStimulusById: async () => null,
      } as never, // stimulusStore
      noopTurnHarness,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      {
        appendMarker: vi.fn().mockResolvedValue(undefined),
        drainAndAdvance: vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
      } as unknown as PipelineAwarenessStore,
      {} as unknown as TicketService,
      {} as unknown as JobDependencyService,
      { engineAuth: async () => undefined, openaiKey: async () => undefined } as unknown as CredentialResolver,
      { resolveForTurn: async () => [] } as never, // mcp (McpResolver)
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        list: async () => [],
        listForRepo: async () => [],
        read: async () => null,
      } as unknown as WorkspaceSecretFileStore,
      {
        listMounts: async () => [],
        upsertMount: async () => undefined,
      } as unknown as WorkspaceConfigStore,
      { hasChanges: async () => false, currentBranch: async () => null, worktreeSafeToRecut: async () => true } as unknown as LocalGitService,
      { generate: () => 'SYSTEM' } as never, // prompts (PromptService)
      { register: () => undefined } as never, // threadInput (ThreadInputService)
      { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (OauthUsageService)
    );
    return { manager, store };
  }

  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

  it('create_job creates an independent follow-up (inheriting the base branch) and starts it', async () => {
    const { manager, store } = makeManager();
    const startSpy = vi.spyOn(manager, 'startFollowUpJob').mockResolvedValue(undefined);

    const result = await manager.buildTools(stimulus)['create_job']({
      title: 'Side task',
      firstMessage: 'do the side task',
    });

    expect(result).toMatchObject({ ok: true, jobId: 'th-followup' });
    expect(mock(store.createFollowUpJob)).toHaveBeenCalledWith({
      orgId: ORG,
      repoId: REPO,
      title: 'Side task',
      baseBranch: 'main', // inherits the parent thread's base
      createdByJobId: THREAD,
      createdByTitle: 'Parent job',
    });
    expect(startSpy).toHaveBeenCalledWith('th-followup', ORG, REPO, 'do the side task');
  });

  it('create_job requires a firstMessage', async () => {
    const { manager, store } = makeManager();
    const result = await manager.buildTools(stimulus)['create_job']({ title: 'x', firstMessage: '  ' });
    expect(result).toMatchObject({ ok: false });
    expect(mock(store.createFollowUpJob)).not.toHaveBeenCalled();
  });

  it('startFollowUpJob records the opening intent, then runs one chat turn', async () => {
    const { manager, store } = makeManager();
    const turn = vi.spyOn(manager, 'handleChatTurn').mockResolvedValue(undefined);

    await manager.startFollowUpJob('th-followup', ORG, REPO, 'kick off the follow-up');

    expect(mock(store.appendAtlasMessage)).toHaveBeenCalledWith(
      'th-followup',
      expect.stringContaining('kick off the follow-up'),
    );
    expect(turn).toHaveBeenCalledOnce();
    const ran = (turn.mock.calls[0][0] as ChatStimulus);
    expect(ran).toMatchObject({ jobId: 'th-followup', orgId: ORG, repoId: REPO, body: 'kick off the follow-up' });
  });
});

describe('AgentSessionManager — direct-build turn-end latch (decision d3)', () => {
  const ORG = 'org-latch';
  const REPO = 'repo-latch';
  const JOB_ID = 'job-latch-1';

  const stimulus: ChatStimulus = {
    kind: 'chat',
    trust: 'trusted',
    id: 'stim-latch-1',
    receivedAt: new Date('2026-06-25T00:00:00Z'),
    orgId: ORG,
    repoId: REPO,
    jobId: JOB_ID,
    body: 'ship it',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
  };

  /** The default `running` direct-build job the latch acts on (domain shape → camelCase branch fields). */
  const runningJob = {
    id: JOB_ID,
    orgId: ORG,
    repoId: REPO,
    status: 'running',
    featureBranch: 'atlas/feature',
    currentBranch: 'atlas/live',
    title: 'Direct build',
  };

  function makeManager(overrides: {
    loadJob?: ReturnType<typeof vi.fn>;
    findSandbox?: ReturnType<typeof vi.fn>;
    resolve?: ReturnType<typeof vi.fn>;
    latchPr?: ReturnType<typeof vi.fn>;
  } = {}) {
    const store = {
      loadJob: overrides.loadJob ?? vi.fn().mockResolvedValue(runningJob),
      setActivity: vi.fn().mockResolvedValue(undefined),
      endTurnActivity: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrainStoreService;
    const lifecycle = {
      findSandbox:
        overrides.findSandbox ??
        vi.fn().mockResolvedValue({ id: 'sbx-1', branch: 'atlas/feature', worktreePath: '/wt' }),
    } as unknown as JobLifecycleService;
    const ship = {
      latchPr: overrides.latchPr ?? vi.fn().mockResolvedValue({ url: 'https://gh/pr/9', number: 9 }),
    } as unknown as BuildShipService;
    const repos = {
      resolve:
        overrides.resolve ??
        vi.fn().mockResolvedValue({ owner: 'o', repo: 'r', defaultBranch: 'main', token: 't' }),
    } as unknown as DriverRepoResolver;

    const manager = new AgentSessionManager(
      store,
      {} as unknown as DriverStoreService,
      {} as unknown as MemoryStore,
      {} as unknown as DecisionApprovalService,
      lifecycle,
      {} as unknown as EngineRunnerPort,
      { listRunning: async () => [] } as never, // turnRegistry
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      { post: vi.fn(), name: 'web' } as unknown as ChatSurface,
      { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<JobSandboxEntity>,
      { findOne: async () => null, update: async () => undefined, find: async () => [] } as never, // stimulusRows
      {
        eligiblePendingChat: async () => [],
        leaseChatStimuli: async () => undefined,
        markChatDelivered: async () => undefined,
        undeliveredChatThreads: async () => [],
        resetChatLeases: async () => undefined,
        findChatStimulusById: async () => null,
      } as never, // stimulusStore
      noopTurnHarness,
      {} as unknown as DecisionClassifier,
      ship,
      repos,
      {
        appendMarker: vi.fn().mockResolvedValue(undefined),
        drainAndAdvance: vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
      } as unknown as PipelineAwarenessStore,
      {} as unknown as TicketService,
      {} as unknown as JobDependencyService,
      { engineAuth: async () => undefined, openaiKey: async () => undefined } as unknown as CredentialResolver,
      { resolveForTurn: async () => [] } as never, // mcp (McpResolver)
      {
        getState: () => 'leader',
        isLeader: () => true,
        onPromote: () => ({ unsubscribe() {} }),
        onDemote: () => ({ unsubscribe() {} }),
      } as never, // election
      { recoverInterruptedTurns: async () => 0 } as unknown as TurnRecoveryService,
      {
        write: async () => undefined,
        list: async () => [],
        listForRepo: async () => [],
        read: async () => null,
      } as unknown as WorkspaceSecretFileStore,
      { listMounts: async () => [], upsertMount: async () => undefined } as unknown as WorkspaceConfigStore,
      { hasChanges: async () => false, currentBranch: async () => null, worktreeSafeToRecut: async () => true } as unknown as LocalGitService,
      { generate: () => 'SYSTEM' } as never, // prompts (PromptService)
      { register: () => undefined } as never, // threadInput (ThreadInputService)
      { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (OauthUsageService)
    );
    return { manager, store, lifecycle, ship, repos };
  }

  /** Access the private pending-flag map + the turn-end latch method the `runChatTurn` finally calls. */
  const pending = (m: AgentSessionManager) =>
    (m as unknown as { directBuildShipPending: Map<string, boolean> }).directBuildShipPending;
  const runLatch = (m: AgentSessionManager, s: ChatStimulus) =>
    (m as unknown as { latchDirectBuildAtTurnEnd: (s: ChatStimulus) => Promise<void> }).latchDirectBuildAtTurnEnd(s);

  it('flag set + running + owning feature_branch → latches the PR on the LIVE branch', async () => {
    const { manager, ship } = makeManager();
    pending(manager).set(JOB_ID, true);

    await runLatch(manager, stimulus);

    // latchPr ran against the LIVE branch (current_branch overrides the host-named feature branch).
    expect(mock(ship.latchPr)).toHaveBeenCalledOnce();
    const [, , sandboxArg] = mock(ship.latchPr).mock.calls[0];
    expect((sandboxArg as { branch: string }).branch).toBe('atlas/live');
    // The flag is CONSUMED (a second turn-end must not re-latch).
    expect(pending(manager).has(JOB_ID)).toBe(false);
  });

  it('falls back to the host feature branch when current_branch is null', async () => {
    const { manager, ship } = makeManager({
      loadJob: vi.fn().mockResolvedValue({ ...runningJob, currentBranch: null }),
    });
    pending(manager).set(JOB_ID, true);

    await runLatch(manager, stimulus);

    const [, , sandboxArg] = mock(ship.latchPr).mock.calls[0];
    expect((sandboxArg as { branch: string }).branch).toBe('atlas/feature');
  });

  it('flag NOT set → no latch (a normal chat turn ends untouched)', async () => {
    const { manager, ship } = makeManager();

    await runLatch(manager, stimulus);

    expect(mock(ship.latchPr)).not.toHaveBeenCalled();
  });

  it('latch MISS (PR not indexed yet) → job left running for the reconciler backstop', async () => {
    const { manager, ship } = makeManager({ latchPr: vi.fn().mockResolvedValue(undefined) });
    pending(manager).set(JOB_ID, true);

    await runLatch(manager, stimulus);

    expect(mock(ship.latchPr)).toHaveBeenCalledOnce();
  });

  it('does NOT latch a non-running job (mirrors the finalize_build refusal gate)', async () => {
    const { manager, ship } = makeManager({
      loadJob: vi.fn().mockResolvedValue({ ...runningJob, status: 'done' }),
    });
    pending(manager).set(JOB_ID, true);

    await runLatch(manager, stimulus);

    expect(mock(ship.latchPr)).not.toHaveBeenCalled();
  });

  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
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

  /** A manager wired with only the deps the event pump (`deliverEvent`/`pumpEvent`/`sweepUndeliveredEvents`)
   *  touches; everything else is an inert stub. Mirrors the chat-pump harness. */
  function makeManager(opts: { events?: EventStimulus[] } = {}) {
    const stimulusStore = {
      leaseChatStimuli: vi.fn().mockResolvedValue(undefined),
      markChatDelivered: vi.fn().mockResolvedValue(undefined),
      eligiblePendingEvents: vi.fn().mockResolvedValue(opts.events ?? []),
      resetEventLeases: vi.fn().mockResolvedValue(undefined),
      findChatStimulusById: vi.fn().mockResolvedValue(eventStimulus),
    };
    const stimulusRows = {
      findOne: vi.fn().mockResolvedValue(null), // not yet delivered
      update: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue([]),
    };
    const runningBrainTurn = vi.fn().mockResolvedValue(null);
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;
    const steer = vi.fn().mockResolvedValue(undefined);
    const engineRunner = { run: vi.fn(), steer } as unknown as EngineRunnerPort;
    const getState = vi.fn().mockReturnValue('leader');
    const election = { getState } as unknown as LeaderElectionService;
    const inert = {} as never;
    const manager = new AgentSessionManager(
      inert, inert, inert, inert, inert, // store, driverStore, memory, approvals, lifecycle (5)
      engineRunner, // engineRunner (6)
      turnRegistry, // turnRegistry (7)
      inert, inert, inert, // planReview, dispatcher, surface (10)
      inert, // sandboxRows (11)
      stimulusRows as never, // stimulusRows (12)
      stimulusStore as never, // stimulusStore (13)
      inert, inert, inert, inert, inert, inert, inert, inert, // turnHarness…creds (21)
      inert, // mcp (McpResolver, 22)
      election, // election (23)
      inert, inert, inert, inert, // turnRecovery, secretStore, configStore, git (27)
      { generate: () => 'SYSTEM' } as never, // prompts (28, PromptService)
      { register: () => undefined } as never, // threadInput (29, ThreadInputService)
      { judge: async () => undefined } as never, // liveVerificationJudge (30, LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (31, OauthUsageService)
    );
    return { manager, stimulusStore, stimulusRows, turnRegistry, runningBrainTurn, engineRunner, steer, election, getState };
  }

  it('a LIVE brain turn: steers the event (event-row id = steer id, leased first), never a fresh turn, NEVER stamps on the bare XADD', async () => {
    const { manager, stimulusStore, stimulusRows, runningBrainTurn, steer } = makeManager();
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.deliverEvent(eventStimulus);

    // Leased BEFORE steering; steer id is the DURABLE event-row id so the engine `input_ack` can stamp THIS row.
    expect(stimulusStore.leaseChatStimuli).toHaveBeenCalledWith(['stim-evt-001']);
    expect(steer).toHaveBeenCalledOnce();
    const [turnId, steerId, body] = steer.mock.calls[0] as [string, string, string];
    expect(turnId).toBe('turn-live');
    expect(steerId).toBe('stim-evt-001');
    // Trusted framing OUTSIDE the fence, the untrusted event body INSIDE it.
    expect(body).toMatch(/no human sent it/i);
    expect(body).toContain('<untrusted');
    expect(body).toContain('CI job #42 failed');
    expect(runChatTurnSpy).not.toHaveBeenCalled();
    // The steer is a bare XADD — delivery is NOT stamped here; only the engine's input_ack marks it delivered.
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();
    expect(stimulusRows.update).not.toHaveBeenCalled();
  });

  it('SWALLOWED-STEER RACE: a live turn steered but no input_ack → the event stays UNDELIVERED (regression)', async () => {
    // The reported bug: an event steered into a just-finishing turn is swallowed, yet the old path stamped
    // delivered anyway. Now a bare steer NEVER stamps — only input_ack does — so the row stays null and the
    // sweep re-drives it.
    const { manager, stimulusStore, stimulusRows, runningBrainTurn, steer } = makeManager();
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-ending' });
    steer.mockResolvedValue(undefined); // XADD ok, but the turn ends before consuming it → no input_ack fires

    await manager.deliverEvent(eventStimulus);

    expect(steer).toHaveBeenCalledOnce();
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled(); // never stamped without an ack
    expect(stimulusRows.update).not.toHaveBeenCalled();
  });

  it('HAPPY steer path: the engine input_ack (on the event-row id) stamps delivered exactly once', async () => {
    const { manager, stimulusStore, runningBrainTurn, steer } = makeManager();
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });
    await manager.deliverEvent(eventStimulus);
    expect(steer).toHaveBeenCalledOnce();

    const stamp = (manager as never as { stampInputAck: (e: EngineEvent) => void }).stampInputAck.bind(manager);
    stamp({ kind: 'input_ack', id: 'stim-evt-001' });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('stim-evt-001');
  });

  it('NO live turn: runs a fresh turn (framed body, event-row id), leased first, stamped at registration', async () => {
    const { manager, stimulusStore } = makeManager();
    const runChatTurnSpy = vi
      .spyOn(manager as never as { runChatTurn: (...a: unknown[]) => Promise<void> }, 'runChatTurn')
      .mockResolvedValue(undefined);

    await manager.deliverEvent(eventStimulus);

    expect(runChatTurnSpy).toHaveBeenCalledOnce();
    const [delivery, deliveryOpts] = runChatTurnSpy.mock.calls[0] as [ChatStimulus, TurnDeliveryOptsLike];
    expect(delivery.id).toBe('stim-evt-001'); // the DURABLE event-row id, not a synthetic uuid
    expect(delivery.jobId).toBe('th-evt-001');
    expect(delivery.seed).toBe(true); // a seed turn → no duplicate operator bubble
    expect(delivery.body).toMatch(/no human sent it/i);
    expect(delivery.body).toContain('<untrusted');
    expect(delivery.body).toContain('CI job #42 failed');
    // Leased before dispatch so a concurrent sweep can't re-drive a duplicate during a long turn.
    expect(stimulusStore.leaseChatStimuli).toHaveBeenCalledWith(['stim-evt-001']);
    // Nothing stamped delivered YET — only at the registration hand-off (restart-survivable point).
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();

    deliveryOpts.onRegistered!();
    await Promise.resolve();
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('stim-evt-001');
  });

  it('a turn appears BETWEEN the pump check and the fresh-turn dispatch: steers instead of double-starting', async () => {
    const { manager, runningBrainTurn, steer } = makeManager();
    runningBrainTurn
      .mockResolvedValueOnce(null) // pumpEvent's own check
      .mockResolvedValueOnce({ turn_id: 'turn-appeared' }); // deliverEventViaFreshTurn's re-check
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.deliverEvent(eventStimulus);

    expect(steer).toHaveBeenCalledWith('turn-appeared', 'stim-evt-001', expect.stringContaining('CI job #42 failed'));
    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-delivered event runs no turn and no steer', async () => {
    const { manager, stimulusRows, steer } = makeManager();
    stimulusRows.findOne.mockResolvedValue({ delivered_at: new Date() });
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.deliverEvent(eventStimulus);

    expect(steer).not.toHaveBeenCalled();
    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  describe('sweepUndeliveredEvents (the leader periodic + boot re-drive)', () => {
    it('LEADER: pumps every eligible undelivered event; a no-live-turn event self-heals via a fresh turn', async () => {
      const { manager, stimulusStore } = makeManager({ events: [eventStimulus] });
      const runChatTurnSpy = vi
        .spyOn(manager as never as { runChatTurn: (...a: unknown[]) => Promise<void> }, 'runChatTurn')
        .mockResolvedValue(undefined);

      await (manager as never as { sweepUndeliveredEvents: () => Promise<void> }).sweepUndeliveredEvents();
      // Flush the fire-and-forget pumpEvent chain (findOne → runningBrainTurn → queue → fresh turn).
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(stimulusStore.eligiblePendingEvents).toHaveBeenCalled();
      expect(runChatTurnSpy).toHaveBeenCalledOnce();
      const [delivery] = runChatTurnSpy.mock.calls[0] as [ChatStimulus];
      expect(delivery.body).toContain('CI job #42 failed');
    });

    it('a FOLLOWER never sweeps events', async () => {
      const { manager, stimulusStore, getState } = makeManager({ events: [eventStimulus] });
      getState.mockReturnValue('follower');

      await (manager as never as { sweepUndeliveredEvents: () => Promise<void> }).sweepUndeliveredEvents();

      expect(stimulusStore.eligiblePendingEvents).not.toHaveBeenCalled();
    });
  });
});

describe('Durable operator-message delivery: AgentSessionManager.pumpThread', () => {
  const JOB_ID = 'th-pump-001';
  const ORG_ID = 'T-PUMP';
  const REPO_ID = 'repo-pump';

  /** A pending chat stimulus, ChatStimulus-shaped, as `stimulusStore.eligiblePendingChat` would resolve it. */
  function pendingRow(id: string, body: string, createdAt: Date): ChatStimulus {
    return {
      id,
      orgId: ORG_ID,
      repoId: REPO_ID,
      kind: 'chat',
      trust: 'trusted',
      jobId: JOB_ID,
      body,
      author: { id: 'U1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: JOB_ID },
      receivedAt: createdAt,
    };
  }

  // Operator messages reach the engine wrapped in a `<user name at>` tag (chunk-vocabulary) reconstructed
  // from the author + receipt time; the steered payload / fresh-turn task is that wrap, not the raw body.
  function userWrap(body: string, at: string): string {
    return `<user name="Dennis" at="${at}">${body}</user>`;
  }

  /** A manager wired with only the deps `pumpThread`/`sweepUndeliveredChat` touch; everything else inert. */
  function makeManager(opts: {
    pending?: ChatStimulus[];
    threads?: Array<{ jobId: string; orgId: string; repoId: string }>;
    jobStatus?: string;
  } = {}) {
    const store = {
      loadJob: vi.fn().mockResolvedValue({ status: opts.jobStatus ?? 'planning' }),
    };
    const stimulusStore = {
      eligiblePendingChat: vi.fn().mockResolvedValue(opts.pending ?? []),
      leaseChatStimuli: vi.fn().mockResolvedValue(undefined),
      markChatDelivered: vi.fn().mockResolvedValue(undefined),
      undeliveredChatThreads: vi.fn().mockResolvedValue(opts.threads ?? []),
      resetChatLeases: vi.fn().mockResolvedValue(undefined),
      findChatStimulusById: vi.fn().mockResolvedValue(null),
    };
    const stimulusRows = {
      findOne: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      find: vi.fn().mockResolvedValue([]),
    };
    const runningBrainTurn = vi.fn().mockResolvedValue(null);
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;
    const steer = vi.fn().mockResolvedValue(undefined);
    const engineRunner = { run: vi.fn(), steer } as unknown as EngineRunnerPort;
    const getState = vi.fn().mockReturnValue('follower');
    const election = { getState } as unknown as LeaderElectionService;
    const inert = {} as never;
    const manager = new AgentSessionManager(
      store as never, inert, inert, inert, inert, // store, driverStore, memory, approvals, lifecycle (5)
      engineRunner, // engineRunner (6)
      turnRegistry, // turnRegistry (7)
      inert, inert, inert, // planReview, dispatcher, surface (10)
      inert, // sandboxRows (11)
      stimulusRows as never, // stimulusRows (12)
      stimulusStore as never, // stimulusStore (13)
      inert, inert, inert, inert, inert, inert, inert, inert, // turnHarness…creds (21)
      inert, // mcp (McpResolver, 22)
      election, // election (23)
      inert, inert, inert, inert, // turnRecovery…git (27)
      { generate: () => 'SYSTEM' } as never, // prompts (28, PromptService)
      { register: () => undefined } as never, // threadInput (ThreadInputService)
      { judge: async () => undefined } as never, // liveVerificationJudge (LIVE_VERIFICATION_JUDGE)
      { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (OauthUsageService)
    );
    return { manager, store, stimulusStore, stimulusRows, turnRegistry, runningBrainTurn, engineRunner, steer, election, getState };
  }

  it('a LIVE brain turn: steers every pending message (leases first), never starts a fresh turn', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const pending = [pendingRow('s1', 'first message', t0), pendingRow('s2', 'second message', t0)];
    const { manager, stimulusStore, runningBrainTurn, steer } = makeManager({ pending });
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    // Leased BEFORE steering (so a concurrent sweep can't re-take these rows mid-flight).
    expect(stimulusStore.leaseChatStimuli).toHaveBeenCalledWith(['s1', 's2']);
    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer).toHaveBeenNthCalledWith(1, 'turn-live', 's1', userWrap('first message', '2026-07-02T12:00:00.000Z'));
    expect(steer).toHaveBeenNthCalledWith(2, 'turn-live', 's2', userWrap('second message', '2026-07-02T12:00:00.000Z'));
    // The steer path never touches the fresh-turn primitive.
    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  it('a LIVE turn but no pending messages: no-op — no steer, no lease write', async () => {
    const { manager, stimulusStore, runningBrainTurn, steer } = makeManager({ pending: [] });
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(steer).not.toHaveBeenCalled();
    expect(stimulusStore.leaseChatStimuli).not.toHaveBeenCalled();
  });

  it('a blocked job parks pending chat without steering, leasing, or starting a fresh turn', async () => {
    const pending = [pendingRow('s1', 'wait for blocker', new Date('2026-07-02T12:00:00Z'))];
    const { manager, stimulusStore, runningBrainTurn, steer } = makeManager({
      pending,
      jobStatus: 'blocked',
    });
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(stimulusStore.eligiblePendingChat).not.toHaveBeenCalled();
    expect(stimulusStore.leaseChatStimuli).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  it('NO live turn: coalesces the pending batch into ONE fresh turn and stamps delivery at registration', async () => {
    const t0 = new Date('2026-07-02T12:00:00Z');
    const t1 = new Date('2026-07-02T12:00:05Z');
    const pending = [pendingRow('s1', 'first message', t0), pendingRow('s2', 'second message', t1)];
    const { manager, stimulusStore } = makeManager({ pending });
    const runChatTurnSpy = vi
      .spyOn(manager as never as { runChatTurn: (...a: unknown[]) => Promise<void> }, 'runChatTurn')
      .mockResolvedValue(undefined);

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(runChatTurnSpy).toHaveBeenCalledOnce();
    const [combined, opts] = runChatTurnSpy.mock.calls[0] as [ChatStimulus, TurnDeliveryOptsLike];
    // Coalesced: one turn, oldest-first body join — the operator still sees each as its own chat bubble
    // (persisted separately at intake); the brain reads them together as this turn's task.
    expect(combined.body).toBe('first message\n\nsecond message');
    // Per-message attribution: one `<user>` chunk each (own name + time), so a batch coalesced from
    // several senders isn't misattributed to the oldest when `engineBody` renders it.
    expect(combined.chunks).toEqual([
      { kind: 'user', body: 'first message', attrs: { name: 'Dennis', at: '2026-07-02T12:00:00.000Z' } },
      { kind: 'user', body: 'second message', attrs: { name: 'Dennis', at: '2026-07-02T12:00:05.000Z' } },
    ]);
    expect(combined.jobId).toBe(JOB_ID);
    expect(typeof opts?.onRegistered).toBe('function');

    // Nothing stamped delivered YET — only at the registration hand-off (restart-survivable point).
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();

    // Simulate the runner's hand-off firing `onTurnRegistered` → onRegistered().
    opts.onRegistered!();
    await Promise.resolve(); // let the fire-and-forget markChatDelivered promises settle one microtask

    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('s1');
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('s2');
  });

  it('NO pending messages and no live turn: a fresh turn is never started', async () => {
    const { manager } = makeManager({ pending: [] });
    const runChatTurnSpy = vi.spyOn(
      manager as never as { runChatTurn: () => void },
      'runChatTurn',
    );

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  it('a turn appears BETWEEN the initial check and the fresh-turn dispatch: steers instead of double-starting', async () => {
    // Regression guard for the race the code comments call out explicitly: pumpThread sees no live turn,
    // queues deliverPendingViaFreshTurn, but a boot re-attach resumes a turn before it actually runs — it
    // must steer that turn, never start a SECOND one resuming the same engine session id.
    const pending = [pendingRow('s1', 'racy message', new Date('2026-07-02T12:00:00Z'))];
    const { manager, runningBrainTurn, steer } = makeManager({ pending });
    runningBrainTurn
      .mockResolvedValueOnce(null) // pumpThread's own check
      .mockResolvedValueOnce({ turn_id: 'turn-appeared' }); // deliverPendingViaFreshTurn's re-check
    const runChatTurnSpy = vi.spyOn(manager as never as { runChatTurn: () => void }, 'runChatTurn');

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(steer).toHaveBeenCalledWith('turn-appeared', 's1', userWrap('racy message', '2026-07-02T12:00:00.000Z'));
    expect(runChatTurnSpy).not.toHaveBeenCalled();
  });

  it('a steer failure does not throw — the message stays undelivered for the sweep to re-drive', async () => {
    const pending = [pendingRow('s1', 'msg', new Date('2026-07-02T12:00:00Z'))];
    const { manager, steer, runningBrainTurn } = makeManager({ pending });
    runningBrainTurn.mockResolvedValue({ turn_id: 'turn-live' });
    steer.mockRejectedValue(new Error('redis xadd failed'));

    await expect(manager.pumpThread(JOB_ID, ORG_ID, REPO_ID)).resolves.toBeUndefined();
  });

  it('stampInputAck marks the acked stimulus delivered; ignores non-ack / id-less events', async () => {
    const { manager, stimulusStore } = makeManager();
    const stamp = (manager as never as { stampInputAck: (e: EngineEvent) => void }).stampInputAck.bind(
      manager,
    );

    stamp({ kind: 'input_ack', id: 's1' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(stimulusStore.markChatDelivered).toHaveBeenCalledWith('s1');

    stimulusStore.markChatDelivered.mockClear();
    stamp({ kind: 'text', text: 'hello' } as EngineEvent);
    expect(stimulusStore.markChatDelivered).not.toHaveBeenCalled();
  });

  describe('sweepUndeliveredChat (the leader periodic + boot re-drive)', () => {
    it('LEADER: pumps every distinct thread with an undelivered chat stimulus', async () => {
      const threads = [
        { jobId: 'th-a', orgId: 'T1', repoId: 'r1' },
        { jobId: 'th-b', orgId: 'T1', repoId: 'r1' },
      ];
      const { manager, getState } = makeManager({ threads });
      getState.mockReturnValue('leader');
      const pumpSpy = vi.spyOn(manager, 'pumpThread').mockResolvedValue(undefined);

      await (manager as never as { sweepUndeliveredChat: () => Promise<void> }).sweepUndeliveredChat();

      expect(pumpSpy).toHaveBeenCalledWith('th-a', 'T1', 'r1');
      expect(pumpSpy).toHaveBeenCalledWith('th-b', 'T1', 'r1');
      expect(pumpSpy).toHaveBeenCalledTimes(2);
    });

    it('NON-LEADER: does nothing (no query, no pump)', async () => {
      const { manager, getState, stimulusStore } = makeManager({ threads: [{ jobId: 'th-a', orgId: 'T1', repoId: 'r1' }] });
      getState.mockReturnValue('follower');
      const pumpSpy = vi.spyOn(manager, 'pumpThread').mockResolvedValue(undefined);

      await (manager as never as { sweepUndeliveredChat: () => Promise<void> }).sweepUndeliveredChat();

      expect(stimulusStore.undeliveredChatThreads).not.toHaveBeenCalled();
      expect(pumpSpy).not.toHaveBeenCalled();
    });
  });

  describe('reconcileWorkOwedReviews (the leader work-owed review re-drive)', () => {
    /** A stranded running review row — old enough (updated_at past the grace) to count as work-owed. */
    const STALE_RUNNING = {
      id: 'rev-1',
      job_id: JOB_ID,
      org_id: ORG_ID,
      status: 'running' as const,
      updated_at: new Date(Date.now() - 5 * 60_000),
    };

    /** A manager wired with the deps the work-owed backstop touches; everything else inert. */
    function makeWorkOwedManager(opts: {
      running?: unknown[];
      job?: { status: string; repoId: string } | null;
      liveTurn?: { turn_id: string } | null;
      pendingChat?: ChatStimulus[];
      leader?: boolean;
    } = {}) {
      const planReview = {
        findRunningReviews: vi.fn().mockResolvedValue(opts.running ?? []),
      };
      const store = {
        loadJob: vi
          .fn()
          .mockResolvedValue(
            opts.job === undefined ? { status: 'planning', repoId: REPO_ID } : opts.job,
          ),
      };
      const runningBrainTurn = vi.fn().mockResolvedValue(opts.liveTurn ?? null);
      const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;
      const stimulusStore = {
        eligiblePendingChat: vi.fn().mockResolvedValue(opts.pendingChat ?? []),
      };
      const getState = vi.fn().mockReturnValue(opts.leader === false ? 'follower' : 'leader');
      const election = { getState } as unknown as LeaderElectionService;
      const inert = {} as never;
      const manager = new AgentSessionManager(
        store as never, inert, inert, inert, inert, // store, driverStore, memory, approvals, lifecycle (5)
        inert, // engineRunner (6)
        turnRegistry, // turnRegistry (7)
        planReview as never, inert, inert, // planReview, dispatcher, surface (10)
        inert, // sandboxRows (11)
        inert, // stimulusRows (12)
        stimulusStore as never, // stimulusStore (13)
        inert, inert, inert, inert, inert, inert, inert, inert, // turnHarness…creds (21)
        inert, // mcp (McpResolver, 22)
        election, // election (23)
        inert, inert, inert, inert, // turnRecovery…git (27)
        { generate: () => 'SYSTEM' } as never, // prompts (28)
        { register: () => undefined } as never, // threadInput (29)
        { judge: async () => undefined } as never, // liveVerificationJudge (30)
        { getResetAt: () => undefined } as unknown as OauthUsageService, // usage (31)
      );
      // The nudge would otherwise run a real engine turn — stub it; we assert on the stimulus it receives.
      const handleChatTurn = vi
        .spyOn(manager, 'handleChatTurn')
        .mockResolvedValue(undefined);
      const run = () =>
        (manager as never as { reconcileWorkOwedReviews: () => Promise<void> }).reconcileWorkOwedReviews();
      return { manager, run, planReview, store, runningBrainTurn, stimulusStore, handleChatTurn, getState };
    }

    it('NON-LEADER: does nothing (no query, no nudge)', async () => {
      const { run, planReview, handleChatTurn } = makeWorkOwedManager({ running: [STALE_RUNNING], leader: false });
      await run();
      expect(planReview.findRunningReviews).not.toHaveBeenCalled();
      expect(handleChatTurn).not.toHaveBeenCalled();
    });

    it('a stranded running review (no live turn, no pending chat): re-drives the brain', async () => {
      const { run, handleChatTurn } = makeWorkOwedManager({ running: [STALE_RUNNING] });
      await run();
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget per-candidate promise settle

      expect(handleChatTurn).toHaveBeenCalledOnce();
      const stim = handleChatTurn.mock.calls[0][0] as ChatStimulus;
      expect(stim.jobId).toBe(JOB_ID);
      expect(stim.seed).toBe(true); // invisible system seed, not an operator bubble
      expect(stim.body).toMatch(/review_plan/); // the nudge tells Atlas to resume review_plan
    });

    it('a review that is still in flight (updated recently) is NOT treated as stranded', async () => {
      const { run, handleChatTurn } = makeWorkOwedManager({
        running: [{ ...STALE_RUNNING, updated_at: new Date() }],
      });
      await run();
      await new Promise((r) => setTimeout(r, 0));
      expect(handleChatTurn).not.toHaveBeenCalled();
    });

    it('a LIVE brain turn already owns the review: skips', async () => {
      const { run, handleChatTurn } = makeWorkOwedManager({
        running: [STALE_RUNNING],
        liveTurn: { turn_id: 'turn-live' },
      });
      await run();
      await new Promise((r) => setTimeout(r, 0));
      expect(handleChatTurn).not.toHaveBeenCalled();
    });

    it('a job already awaiting_approval / running no longer owes a review: skips', async () => {
      const { run, handleChatTurn } = makeWorkOwedManager({
        running: [STALE_RUNNING],
        job: { status: 'awaiting_approval', repoId: REPO_ID },
      });
      await run();
      await new Promise((r) => setTimeout(r, 0));
      expect(handleChatTurn).not.toHaveBeenCalled();
    });

    it('an operator/system chat is still pending: defers to the chat sweep (no nudge)', async () => {
      const { run, handleChatTurn } = makeWorkOwedManager({
        running: [STALE_RUNNING],
        pendingChat: [pendingRow('s1', 'hold on', new Date())],
      });
      await run();
      await new Promise((r) => setTimeout(r, 0));
      expect(handleChatTurn).not.toHaveBeenCalled();
    });
  });

  it('DRAINING: pumpThread is a no-op (new turns are already rejected at the surface; this guards internal callers)', async () => {
    const { manager, getState, steer, stimulusStore } = makeManager({ pending: [pendingRow('s1', 'msg', new Date())] });
    getState.mockReturnValue('draining');

    await manager.pumpThread(JOB_ID, ORG_ID, REPO_ID);

    expect(steer).not.toHaveBeenCalled();
    expect(stimulusStore.eligiblePendingChat).not.toHaveBeenCalled();
  });
});
