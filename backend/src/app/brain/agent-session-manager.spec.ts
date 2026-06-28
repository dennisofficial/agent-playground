import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatStimulus } from '../domain';
import type { JobDispatcher } from './job-dispatcher';
import type { BrainStoreService } from './brain-store.service';
import type { DecisionApprovalService } from './decision-approval.service';
import type { DriverStoreService } from '../driver/driver-store.service';
import type { MemoryStore } from '../memory';
import type { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import type { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import type { BuildShipService } from '../driver/build-ship.service';
import type { DriverRepoResolver } from '../driver/repo-resolver';
import type { PipelineAwarenessStore } from '../driver/pipeline-awareness.store';
import type { TicketService } from '../tickets';
import type { DecisionClassifier } from '../decision-gate';
import type { ChatSurface, LiveTurnStore } from '../surface';
import type { Repository } from 'typeorm';
import type { ThreadSandboxEntity } from '../persistence/entities';
import { AgentSessionManager } from './agent-session-manager.service';
import { ProvisioningNotReadyError } from '../driver/thread-lifecycle.service';
import type { EngineEvent, RunEngineArgs } from '../engine/engine.types';
import type { EventTriageService } from './event-triage.service';
import type { EventStimulus } from '../domain';
import { StimulusRouter } from './stimulus-router.service';
import type { PlanReviewService } from './plan-review.service';
import type { CredentialResolver } from '../onboarding';

/**
 * R3 GATE TESTS — two assertions:
 *   (a) A chat turn's `submit_plan` tool call persists a detailed decision record + tracks
 *       (offline-deterministic, fake bridge — drives `buildTools()` directly, no real engine).
 *   (b) An EVENT still parks/dispatches via `EventTriageService` (the event lane is UNCHANGED).
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
    approve: vi.fn(),
    cancel: vi.fn(),
    reopenScoping: vi.fn(),
    loadJob: vi.fn(),
    // Working-set decisions (create_decision / submit_plan source these); default to empty.
    pendingDecisions: vi.fn().mockResolvedValue([]),
    createDecision: vi.fn().mockResolvedValue({ decision: { id: 'd1' }, all: [{ id: 'd1' }] }),
    updateDecision: vi.fn().mockResolvedValue(null),
    deleteDecision: vi.fn().mockResolvedValue({ removed: false, all: [] }),
    appendCardMessage: vi.fn(),
    updateCardMessage: vi.fn(),
    latestAnsweredQuestionCard: vi.fn().mockResolvedValue(null),
    latestUnansweredQuestionCard: vi.fn().mockResolvedValue(null),
    // Durable human-input gate (ask_question lifecycle); default to "no question open".
    openQuestion: vi.fn().mockResolvedValue({ ok: true }),
    awaitingQuestionId: vi.fn().mockResolvedValue(null),
    getQuestionCard: vi.fn().mockResolvedValue(null),
    markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
    clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
    findUndeliveredAnsweredQuestions: vi.fn().mockResolvedValue([]),
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
  } as unknown as ThreadLifecycleService;

  const mockDockerRunner = {} as unknown as DockerEngineRunner;

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
   * R4: mock PlanReviewService that immediately returns null (guard already fired) — so the R3 spec's
   * assertions on persistPlan + approval card still hold.  The R4 spec separately exercises the review
   * flow in full.
   */
  const mockPlanReview = {
    review: vi.fn().mockResolvedValue(null),
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
  } as unknown as Repository<ThreadSandboxEntity>;

  const mockLiveTurns = {
    push: vi.fn(),
    end: vi.fn(),
    snapshot: vi.fn(),
    snapshotsForRepo: vi.fn(),
  } as unknown as LiveTurnStore;

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
    threadId: THREAD_ID,
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
    (mockStore.latestUnansweredQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Human-input gate defaults: opening succeeds, no question currently open.
    (mockStore.openQuestion as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    (mockStore.awaitingQuestionId as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.markQuestionDelivered as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockStore.clearAwaitingQuestion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (mockLifecycle.contextDirHost as ReturnType<typeof vi.fn>).mockReturnValue('/tmp/atlas-test-ctx');

    // persistPlan returns the canonical shape BrainStoreService returns.
    (mockStore.persistPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      thread: {
        id: FAKE_JOB_ID,
        status: 'awaiting_approval',
        title: 'Add rate limiting to the API',
        kind: 'feature',
        org_id: TEAM_ID,
        repo_id: PROJECT_ID,
        thread_id: THREAD_ID,
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
      mockPlanReview,
      mockDispatcher,
      mockSurface,
      mockSandboxRows,
      mockLiveTurns,
      mockClassifier,
      mockShip,
      mockRepos,
      mockAwareness,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
    );
  });

  it('(a) submit_plan: persists overview + decisions + structured tracks-with-steps + goal as title', async () => {
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
    const tracks = [
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

    const result = await tools['submit_plan']({ goal, overview, decisions, tracks });

    // 1. persistPlan gets the track titles AND the per-track authored steps + title=goal.
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.overview).toBe(overview);
    expect(persistArgs.decisions).toHaveLength(2);
    expect(persistArgs.title).toBe(goal);
    expect(persistArgs.trackTitles).toEqual(['RateLimiter guard', 'Integration tests']);
    expect(persistArgs.stepsByTrack).toHaveLength(2);
    expect(persistArgs.stepsByTrack[0]).toHaveLength(2);
    expect(persistArgs.stepsByTrack[0][0]).toMatchObject({ title: 'Add the guard' });
    expect(persistArgs.stepsByTrack[1]).toHaveLength(1);
    expect(persistArgs.orgId).toBe(TEAM_ID);
    expect(persistArgs.repoId).toBe(PROJECT_ID);

    // 2. The tool returns ok=true + the job and record ids.
    expect(result).toMatchObject({ ok: true, jobId: FAKE_JOB_ID, decisionRecordId: FAKE_RECORD_ID });

    // 3. The approval card fires async with the PERSISTED short title (persistPlan titles the thread;
    //    the card + the live thread_meta frame mirror it, not the raw goal), and §H publishes that frame.
    const persistedTitle = 'Add rate limiting to the API'; // what the persistPlan mock returns as job.title
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    const approvalArgs = (mockApprovals.request as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(approvalArgs.title).toBe(persistedTitle);
    expect(approvalArgs.tracks).toEqual(['RateLimiter guard', 'Integration tests']);
    expect(mockSurface.emitThreadMeta).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID, persistedTitle);
  });

  it('(a) submit_plan: returns error (no persist) if goal is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      overview: 'some overview',
      tracks: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error if a track has no steps', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      overview: 'some overview',
      tracks: [{ title: 'S', steps: [] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error if overview is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      tracks: [{ title: 'S', steps: [{ title: 'p', brief: 'b' }] }],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error if tracks are missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      goal: 'g',
      overview: 'some overview',
      decisions: [],
      tracks: [],
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
    // Minimal record: no tracks.
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistArgs.trackTitles).toEqual([]);
    expect(persistArgs.overview).toContain('off-by-one');

    // The card is the lightweight 'direct' variant carrying the change outline.
    await new Promise((r) => setTimeout(r, 0));
    const approvalArgs = (mockApprovals.request as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(approvalArgs.kind).toBe('direct');
    expect(approvalArgs.tracks).toEqual(['adjust the slice bound in paginate()']);
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

  it('(e) ask_question is a DEFERRED gate: the bridge handler is a defensive no-op (defer opens the card)', async () => {
    // The tool stays DECLARED (so the model can call it) but a PreToolUse `defer` hook suspends it before
    // the handler runs — the host opens the card from the deferred-tool outcome, not here. Reaching this
    // handler means the hook didn't fire, so it must refuse rather than silently bypass the gate.
    const tools = manager.buildTools(fakeStimulus);
    expect(tools['ask_question']).toBeTypeOf('function'); // still declared
    const result = await tools['ask_question']({ question: 'Should never run', options: [] });
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain('deferred');
    expect(mockStore.openQuestion).not.toHaveBeenCalled(); // the handler does NOT open the gate
  });

  it('(f) create_decision attaches the gate-pointed answered question and returns the resolved decision + id', async () => {
    // create_decision sources the Q&A authoritatively from the human-input gate pointer, not a scan.
    (mockStore.awaitingQuestionId as ReturnType<typeof vi.fn>).mockResolvedValue('q-123');
    (mockStore.getQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'question_card',
      question: 'Editable or fixed after checkout?',
      answer: 'Editable in the Network tab',
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

  it('(f2) the deprecated log_decision alias still creates a decision', async () => {
    const tools = manager.buildTools(fakeStimulus);
    expect(tools['log_decision']).toBe(tools['create_decision']);
    const result = await tools['log_decision']({ decisionClass: 'data_model', ruling: 'x' });
    expect(result).toMatchObject({ ok: true });
    expect(mockStore.createDecision).toHaveBeenCalled();
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
      { jobId: FAKE_JOB_ID, decisionRecordId: FAKE_RECORD_ID, title: 'rate limiting', summary: 'x', decisions: [], tracks: [] } as never,
    );

    // The build was dispatched (the durable action) — and the milestones were buffered AFTER it, not pushed.
    expect(mockDispatcher.dispatch as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(runningJob);
    const markerIds = (mockAwareness.appendMarker as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[1] as { id: string }).id,
    );
    expect(markerIds).toContain(`approved:${FAKE_RECORD_ID}`);
    expect(markerIds).toContain(`dispatched:${FAKE_RECORD_ID}`);
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
    threadId: THREAD_ID,
    body: 'Explain the build step',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', threadRef: 'ts-stream-001' },
  };

  function makeManager(opts: {
    findSandbox?: unknown;
    ensureProvisioned?: ReturnType<typeof vi.fn>;
    run?: ReturnType<typeof vi.fn>;
    drainAndAdvance?: ReturnType<typeof vi.fn>;
  }) {
    const store = {
      route: vi.fn().mockResolvedValue({ channel: PROJECT_ID, threadTs: THREAD_ID }),
      appendBlock: vi.fn().mockResolvedValue(undefined),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      latestUnansweredQuestionCard: vi.fn().mockResolvedValue(null),
      openQuestion: vi.fn().mockResolvedValue({ ok: true }),
      awaitingQuestionId: vi.fn().mockResolvedValue(null),
      getQuestionCard: vi.fn().mockResolvedValue(null),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
      pairDeferredToolResult: vi.fn().mockResolvedValue(undefined),
      setTurnActive: vi.fn().mockResolvedValue(undefined),
    } as unknown as BrainStoreService;
    const lifecycle = {
      findSandbox: vi.fn().mockResolvedValue(opts.findSandbox ?? null),
      ensureProvisioned:
        opts.ensureProvisioned ?? vi.fn().mockResolvedValue({ id: 'sb-1', lifecycle: 'attached' }),
      ensureContainer: vi
        .fn()
        .mockResolvedValue({ sandbox: { worktreePath: '/wt', containerId: 'c1' }, wasReset: false }),
    } as unknown as ThreadLifecycleService;
    const surface = {
      post: vi.fn().mockResolvedValue('ts'),
      name: 'web',
    } as unknown as ChatSurface;
    const sandboxRows = {
      findOne: vi.fn().mockResolvedValue({ thread_id: THREAD_ID, org_id: TEAM_ID, session_id: null }),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as Repository<ThreadSandboxEntity>;
    const dockerRunner = { run: opts.run ?? vi.fn().mockResolvedValue({ result: '', sessionId: 's' }) } as unknown as DockerEngineRunner;
    const liveTurns = { push: vi.fn(), end: vi.fn() } as unknown as LiveTurnStore;
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
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      surface,
      sandboxRows,
      liveTurns,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      awareness,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
    );
    return { manager, store, lifecycle, surface, sandboxRows, dockerRunner, liveTurns, awareness };
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
    const { manager, store, surface, liveTurns, dockerRunner } = makeManager({ run });

    await manager.handleChatTurn(stimulus);

    // richStream is requested for the brain turn.
    const runArgs = (dockerRunner.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
    expect(runArgs.richStream).toBe(true);

    // Every engine event was pushed LIVE into the resumable store, then the turn was ended (turn_end).
    const pushed = (liveTurns.push as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[2] as EngineEvent).kind,
    );
    expect(pushed).toEqual(['session', 'thinking', 'text', 'tool_use', 'tool_result', 'text', 'result']);
    expect(liveTurns.end as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    // The authoritative blocks were persisted: thinking, two text (chat) blocks, and one paired tool call.
    const blocks = (store.appendBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
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

  it('DEFERRED ask_question: the turn ends on a deferred call → host opens the gate from input.args + the SDK tool_use id', async () => {
    // The turn passes `deferToolNames:['ask_question']`, and the engine returns a deferred outcome.
    const run = vi.fn(async (args: RunEngineArgs) => {
      expect(args.deferToolNames).toEqual(['ask_question']); // ask_question is deferred
      args.onEvent?.({ kind: 'tool_use', id: 'tu-ask', name: 'mcp__atlas-host-bridge__ask_question', input: {} });
      return {
        result: '',
        sessionId: 's',
        deferredToolUse: {
          id: 'tu-ask',
          name: 'mcp__atlas-host-bridge__ask_question',
          input: { args: { question: 'Pick A or B?', options: ['A', 'B'], decisionClass: 'data_model' } },
        },
      };
    });
    const { manager, store } = makeManager({ findSandbox: { worktreePath: '/wt' }, run });

    await manager.handleChatTurn(stimulus);

    // The host opened the gate from the DEFERRED call (not the bridge handler), storing the SDK tool_use
    // id on the card so a later delivery turn can resume and feed the answer back.
    expect(store.openQuestion).toHaveBeenCalledOnce();
    const card = (store.openQuestion as ReturnType<typeof vi.fn>).mock.calls[0][1].card;
    expect(card).toMatchObject({
      type: 'question_card',
      question: 'Pick A or B?',
      decisionClass: 'data_model',
      deferredToolUseId: 'tu-ask',
    });
    expect(card.options).toHaveLength(2);
  });

  it('DELIVERY turn: an answered+undelivered gate resumes the deferred tool, then finalizes (delivered + paired)', async () => {
    const run = vi.fn(async (args: RunEngineArgs) => {
      // This turn RESUMES, feeding the answer back as the deferred tool result (not a fresh task prompt).
      expect(args.deferredResult).toEqual({ toolUseId: 'tu-ask', result: 'A' });
      args.onEvent?.({ kind: 'text', text: 'You chose A — proceeding.' });
      return { result: 'You chose A — proceeding.', sessionId: 's' };
    });
    const { manager, store } = makeManager({ findSandbox: { worktreePath: '/wt' }, run });
    // The gate points at an answered, not-yet-delivered question carrying its deferred tool_use id.
    (store.awaitingQuestionId as ReturnType<typeof vi.fn>).mockResolvedValue('q-1');
    (store.getQuestionCard as ReturnType<typeof vi.fn>).mockResolvedValue({
      type: 'question_card',
      question: 'Pick A or B?',
      answer: 'A',
      deferredToolUseId: 'tu-ask',
    });

    await manager.handleChatTurn(stimulus);

    // On the success tail: stamped delivered, gate cleared, and the deferred tool block paired with the answer.
    expect(store.markQuestionDelivered).toHaveBeenCalledWith(THREAD_ID, 'q-1');
    expect(store.clearAwaitingQuestion).toHaveBeenCalledWith(THREAD_ID, 'q-1');
    expect(store.pairDeferredToolResult).toHaveBeenCalledWith(THREAD_ID, 'tu-ask', 'A');
    expect(store.openQuestion).not.toHaveBeenCalled(); // no new question this turn
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
    threadId: THREAD,
    body: 'Do thing A, then a follow-up for thing B',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', threadRef: THREAD },
  };

  function makeManager(storeOverrides: Record<string, unknown> = {}) {
    const store = {
      loadJob: vi.fn().mockResolvedValue({ baseBranch: 'main' }),
      createFollowUpThread: vi.fn().mockResolvedValue('th-followup'),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      latestUnansweredQuestionCard: vi.fn().mockResolvedValue(null),
      awaitingQuestionId: vi.fn().mockResolvedValue(null),
      getQuestionCard: vi.fn().mockResolvedValue(null),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingQuestion: vi.fn().mockResolvedValue(undefined),
      setTurnActive: vi.fn().mockResolvedValue(undefined),
      ...storeOverrides,
    } as unknown as BrainStoreService;
    const manager = new AgentSessionManager(
      store,
      {} as unknown as DriverStoreService,
      {} as unknown as MemoryStore,
      {} as unknown as DecisionApprovalService,
      {} as unknown as ThreadLifecycleService,
      {} as unknown as DockerEngineRunner,
      {} as unknown as PlanReviewService,
      {} as unknown as JobDispatcher,
      { post: vi.fn(), name: 'web' } as unknown as ChatSurface,
      { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<ThreadSandboxEntity>,
      { push: vi.fn(), end: vi.fn() } as unknown as LiveTurnStore,
      {} as unknown as DecisionClassifier,
      {} as unknown as BuildShipService,
      {} as unknown as DriverRepoResolver,
      {
        appendMarker: vi.fn().mockResolvedValue(undefined),
        drainAndAdvance: vi.fn().mockResolvedValue({ markers: [], stateChanged: false }),
      } as unknown as PipelineAwarenessStore,
      {} as unknown as TicketService,
      { engineAuth: async () => undefined } as unknown as CredentialResolver,
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

    expect(result).toMatchObject({ ok: true, threadId: 'th-followup' });
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
    expect(ran).toMatchObject({ threadId: 'th-followup', orgId: ORG, repoId: REPO, body: 'kick off the follow-up' });
  });
});

describe('R3 gate: StimulusRouter — (b) event lane still parks/dispatches via EventTriageService', () => {
  it('routes an event stimulus to EventTriageService.triageEvent, NOT the chat brain', async () => {
    const mockBrain = {
      handleChatTurn: vi.fn(),
    };
    const mockEvents = {
      triageEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventTriageService;

    const router = new StimulusRouter(
      mockBrain as unknown as AgentSessionManager,
      mockEvents,
    );

    const eventStimulus: EventStimulus = {
      kind: 'event',
      trust: 'untrusted',
      id: 'stim-router-evt-001',
      receivedAt: new Date('2026-06-21T00:00:00Z'),
      orgId: 'T-ROUTER',
      repoId: 'router-proj',
      body: 'CI job #42 failed on the main branch.',
      source: 'github',
      dedupeKey: 'ci-run-42',
      severity: 'warning',
    };

    await router.consume(eventStimulus);

    // EventTriageService received the event.
    expect(mockEvents.triageEvent).toHaveBeenCalledOnce();
    expect(mockEvents.triageEvent).toHaveBeenCalledWith(eventStimulus);

    // The chat brain was NOT touched.
    expect(mockBrain.handleChatTurn).not.toHaveBeenCalled();
  });

  it('routes a chat stimulus to AgentSessionManager.handleChatTurn, NOT EventTriageService', async () => {
    const mockBrain = {
      handleChatTurn: vi.fn().mockResolvedValue(undefined),
    };
    const mockEvents = {
      triageEvent: vi.fn(),
    } as unknown as EventTriageService;

    const router = new StimulusRouter(
      mockBrain as unknown as AgentSessionManager,
      mockEvents,
    );

    const chatStimulus: ChatStimulus = {
      kind: 'chat',
      trust: 'trusted',
      id: 'stim-router-chat-001',
      receivedAt: new Date('2026-06-21T00:00:00Z'),
      orgId: 'T-ROUTER',
      repoId: 'router-proj',
      threadId: 'th-router-001',
      body: 'Add a README track',
      author: { id: 'U-OP', displayName: 'Op' },
      replyRoute: { surfaceId: 'agent', threadRef: 'ts-router-001' },
    };

    await router.consume(chatStimulus);

    // The chat brain received the chat stimulus.
    expect(mockBrain.handleChatTurn).toHaveBeenCalledOnce();
    expect(mockBrain.handleChatTurn).toHaveBeenCalledWith(chatStimulus);

    // EventTriageService was NOT touched.
    expect(mockEvents.triageEvent).not.toHaveBeenCalled();
  });
});
