import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatStimulus } from '../domain';
import type { JobDispatcher } from './job-dispatcher';
import type { BrainStoreService } from './brain-store.service';
import type { DecisionApprovalService } from './decision-approval.service';
import type { DriverStoreService } from '../driver/driver-store.service';
import type { MemoryStore } from '../memory';
import type { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import type { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import type { ChatSurface } from '../surface';
import type { Repository } from 'typeorm';
import type { ThreadSandboxEntity } from '../persistence/entities';
import { AgentSessionManager } from './agent-session-manager.service';
import type { EventTriageService } from './event-triage.service';
import type { EventStimulus } from '../domain';
import { StimulusRouter } from './stimulus-router.service';
import type { PlanReviewService } from './plan-review.service';

/**
 * R3 GATE TESTS — two assertions:
 *   (a) A chat turn's `submit_plan` tool call persists a detailed decision record + sections
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
  } as unknown as ThreadLifecycleService;

  const mockDockerRunner = {} as unknown as DockerEngineRunner;

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
  } as unknown as ChatSurface;

  const mockSandboxRows = {
    findOne: vi.fn(),
    save: vi.fn(),
  } as unknown as Repository<ThreadSandboxEntity>;

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

    // By default: no existing open job on the thread → openJob creates a fresh one.
    (mockStore.openJobOnThread as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.openJob as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_JOB_ID);

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
    );
  });

  it('(a) submit_plan: persists overview + locked decisions + sections via BrainStoreService.persistPlan', async () => {
    const tools = manager.buildTools(fakeStimulus);

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
    const sections = [
      'Implement the RateLimiter guard in backend/src/common/guards/rate-limit.guard.ts ' +
        'using RedisService.incr + EXPIRE pattern; attach it to the ApiController.',
      'Add integration tests in backend/src/common/guards/rate-limit.guard.spec.ts ' +
        'covering the 429 path and Retry-After header; run pnpm test to confirm green.',
    ];

    const result = await tools['submit_plan']({ overview, decisions, sections });

    // 1. persistPlan is called with all the structured data.
    expect(mockStore.persistPlan).toHaveBeenCalledOnce();
    const persistArgs = (mockStore.persistPlan as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Overview is preserved verbatim.
    expect(persistArgs.overview).toBe(overview);

    // Decisions are normalized and passed through — both locked decisions present with correct shape.
    expect(persistArgs.decisions).toHaveLength(2);
    expect(persistArgs.decisions[0]).toMatchObject({
      decisionClass: 'infrastructure',
      title: 'Rate-limit backend',
      ruling: expect.stringContaining('Redis'),
    });
    expect(persistArgs.decisions[1]).toMatchObject({
      decisionClass: 'api_contract',
      title: '429 response shape',
      ruling: expect.stringContaining('rate_limited'),
    });

    // Sections are normalized and passed through — both section briefs present, detailed.
    expect(persistArgs.sectionBriefs).toHaveLength(2);
    expect(persistArgs.sectionBriefs[0]).toContain('RateLimiter guard');
    expect(persistArgs.sectionBriefs[1]).toContain('integration tests');

    // The job/team/project binding is correct.
    expect(persistArgs.orgId).toBe(TEAM_ID);
    expect(persistArgs.repoId).toBe(PROJECT_ID);
    expect(persistArgs.threadId).toBe(FAKE_JOB_ID);

    // 2. The tool returns ok=true + the job and record ids.
    expect(result).toMatchObject({
      ok: true,
      jobId: FAKE_JOB_ID,
      decisionRecordId: FAKE_RECORD_ID,
    });

    // 3. The approval card fires async — approvals.request is called with the card.
    // Give the microtask queue one tick to process the fire-and-forget.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    const approvalArgs = (mockApprovals.request as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(approvalArgs.jobId).toBe(FAKE_JOB_ID);
    expect(approvalArgs.decisionRecordId).toBe(FAKE_RECORD_ID);
    expect(approvalArgs.decisions).toHaveLength(2);
    expect(approvalArgs.sections).toHaveLength(2);
  });

  it('(a) submit_plan: returns error if overview is missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      decisions: [],
      sections: ['do the thing'],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
  });

  it('(a) submit_plan: returns error if sections are missing', async () => {
    const tools = manager.buildTools(fakeStimulus);
    const result = await tools['submit_plan']({
      overview: 'some overview',
      decisions: [],
      sections: [],
    });
    expect(result).toMatchObject({ ok: false });
    expect(mockStore.persistPlan).not.toHaveBeenCalled();
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
      body: 'Add a README section',
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
