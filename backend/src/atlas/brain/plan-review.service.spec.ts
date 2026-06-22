import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PlanReviewService, parsePlanFindings, buildRevisionInstruction } from './plan-review.service';
import type { EngineRunnerPort, RunEngineArgs } from '../engine/engine.types';
import type { ChatStimulus } from '../domain';
import type { BrainStoreService } from './brain-store.service';
import type { DecisionApprovalService } from './decision-approval.service';
import type { DriverStoreService } from '../driver/driver-store.service';
import type { AtlasMemoryStore } from '../memory';
import type { ThreadLifecycleService } from '../driver/thread-lifecycle.service';
import type { DockerEngineRunner } from '../sandbox/docker-engine-runner';
import type { ChatSurface } from '../surface';
import type { Repository } from 'typeorm';
import type { AtlasThreadSandbox } from '../persistence/entities';
import type { EnvService } from '@core/config/env/env.service';
import type { JobDispatcher } from './job-dispatcher';
import { AgentSessionManager } from './agent-session-manager.service';

/**
 * R4 GATE TESTS — two assertions:
 *
 * (a) PlanReviewService unit tests:
 *   - parsePlanFindings correctly extracts FINDING: lines and recognises NO_FINDINGS.
 *   - review() returns { findings } on the FIRST call for a job (one Codex turn run).
 *   - review() returns null on the SECOND call for the SAME job (one-pass guard).
 *
 * (b) AgentSessionManager integration test (fake engine):
 *   - First submit_plan: Codex review fires, findings are returned in the tool response (no
 *     approval card yet).
 *   - Second submit_plan (same job, after revision): review guard fires, approval card raised
 *     exactly once.
 *   → Combined: EXACTLY one Codex review pass + one revision before the approval card.
 */

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A fake EngineRunnerPort that records calls and returns a configured result. */
function fakeEngine(output: string): {
  engine: EngineRunnerPort;
  calls: Array<{ engine: string; mode: string; task: string }>;
} {
  const calls: Array<{ engine: string; mode: string; task: string }> = [];
  const engine: EngineRunnerPort = {
    run: vi.fn(async (args: RunEngineArgs) => {
      calls.push({ engine: args.engine, mode: args.mode, task: args.task });
      return { result: output, sessionId: 'rev-sess-1' };
    }),
  };
  return { engine, calls };
}

/** A fake EngineRunnerPort that throws on every run() call. */
function failingEngine(): EngineRunnerPort {
  return {
    run: vi.fn(async () => {
      throw new Error('engine boom');
    }),
  };
}

const FAKE_SANDBOX = {
  projectId: 'test-proj',
  branch: 'main',
  worktreePath: '/wt/test',
  gitUrl: '',
};

const BASE_INPUT = {
  jobId: 'job-r4-001',
  teamId: 'T-R4',
  worktreePath: '/wt/test',
  overview: 'Add OAuth2 login to the API.',
  decisions: [
    { decisionClass: 'infrastructure' as const, title: 'Auth provider', ruling: 'Use Auth0.' },
  ],
  sectionBriefs: ['Implement the OAuth2 callback handler.', 'Add JWT validation middleware.'],
};

// ── (a) PlanReviewService unit tests ─────────────────────────────────────────────────────────────

describe('parsePlanFindings', () => {
  it('returns empty string when output contains NO_FINDINGS', () => {
    expect(parsePlanFindings('NO_FINDINGS')).toBe('');
    expect(parsePlanFindings('The plan looks great.\nNO_FINDINGS')).toBe('');
  });

  it('extracts FINDING: lines stripping the prefix', () => {
    const output = [
      'Here is my review.',
      'FINDING: Section 1 brief is too vague to implement without re-asking.',
      'FINDING: Missing error-handling decision for OAuth callback failures.',
      'Looks otherwise ok.',
    ].join('\n');
    const result = parsePlanFindings(output);
    expect(result).toContain('Section 1 brief is too vague');
    expect(result).toContain('Missing error-handling decision');
    // Each finding on its own bullet line
    expect(result.split('\n')).toHaveLength(2);
  });

  it('returns empty string when no FINDING: lines and no NO_FINDINGS marker', () => {
    expect(parsePlanFindings('Some general commentary without any findings.')).toBe('');
  });

  it('is case-insensitive for the FINDING: prefix', () => {
    const result = parsePlanFindings('finding: lower case finding\nFINDING: UPPER CASE FINDING');
    expect(result.split('\n')).toHaveLength(2);
  });
});

describe('PlanReviewService — one-pass guard + Codex turn', () => {
  it('FIRST call: runs ONE Codex review turn and returns findings', async () => {
    const { engine, calls } = fakeEngine(
      'FINDING: The section briefs are too vague.\nFINDING: Missing dependency decision.',
    );
    const service = new PlanReviewService(engine);

    const result = await service.review(BASE_INPUT);

    // One Codex turn was run.
    expect(calls).toHaveLength(1);
    expect(calls[0].engine).toBe('codex');
    expect(calls[0].mode).toBe('review');

    // Result is not null (first pass) and has findings.
    expect(result).not.toBeNull();
    expect(result!.findings).toContain('section briefs are too vague');
    expect(result!.findings).toContain('Missing dependency decision');
  });

  it('FIRST call with NO_FINDINGS: runs ONE Codex review turn, returns empty findings', async () => {
    const { engine, calls } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(engine);

    const result = await service.review(BASE_INPUT);

    expect(calls).toHaveLength(1);
    expect(result).not.toBeNull();
    expect(result!.findings).toBe('');
  });

  it('SECOND call for same job: guard fires, returns null (no Codex turn, 0 calls on this call)', async () => {
    const { engine, calls } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(engine);

    // First call — runs review.
    await service.review(BASE_INPUT);
    expect(calls).toHaveLength(1);

    // Second call for the SAME jobId — guard fires.
    const result = await service.review(BASE_INPUT);
    expect(result).toBeNull();
    // No additional engine turn was run.
    expect(calls).toHaveLength(1);
  });

  it('SECOND call for a DIFFERENT job: guard does NOT fire, runs another review', async () => {
    const { engine, calls } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(engine);

    await service.review({ ...BASE_INPUT, jobId: 'job-A' });
    const result = await service.review({ ...BASE_INPUT, jobId: 'job-B' });

    expect(calls).toHaveLength(2);
    expect(result).not.toBeNull(); // not null — second call was for a different job
  });

  it('engine failure is best-effort: returns { findings: "" } and does not throw', async () => {
    const service = new PlanReviewService(failingEngine());

    // Should NOT throw.
    const result = await service.review(BASE_INPUT);

    expect(result).not.toBeNull();
    expect(result!.findings).toBe('');
  });

  it('containerId is threaded through to the engine target when sandbox is docker', async () => {
    const { engine, calls } = fakeEngine('NO_FINDINGS');
    const service = new PlanReviewService(engine);

    await service.review({ ...BASE_INPUT, containerId: 'container-abc123' });

    // The run args should include target.containerId.
    const runArgs = (engine.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunEngineArgs;
    expect(runArgs.target).toBeDefined();
    expect(runArgs.target!.containerId).toBe('container-abc123');
  });
});

// ── (b) AgentSessionManager integration: exactly one review pass + one revision + one card ─────

describe('R4 gate: AgentSessionManager.submit_plan — one Codex review pass + one revision before approval card', () => {
  let planReview: PlanReviewService;
  let reviewEngine: EngineRunnerPort;
  let reviewEngineCalls: Array<{ engine: string; mode: string }>;

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
  } as unknown as AtlasMemoryStore;

  const mockApprovals = {
    request: vi.fn(),
  } as unknown as DecisionApprovalService;

  const mockLifecycle = {
    findSandbox: vi.fn(),
  } as unknown as ThreadLifecycleService;

  const mockDockerRunner = {} as unknown as DockerEngineRunner;

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
  } as unknown as Repository<AtlasThreadSandbox>;

  const mockEnv = {
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as EnvService;

  const TEAM_ID = 'T-R4GATE';
  const PROJECT_ID = 'r4gate-proj';
  const THREAD_ID = 'th-r4gate-001';
  const FAKE_JOB_ID = 'job-r4gate-001';
  const FAKE_RECORD_ID = 'rec-r4gate-001';

  const fakeStimulus: ChatStimulus = {
    kind: 'chat',
    trust: 'trusted',
    id: 'stim-r4gate-001',
    receivedAt: new Date('2026-06-21T00:00:00Z'),
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    body: 'Add OAuth2 login',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'agent', threadRef: 'ts-r4gate-001' },
  };

  const planArgs = {
    overview: 'Add OAuth2 login to the API.',
    decisions: [
      {
        decisionClass: 'infrastructure',
        title: 'Auth provider',
        ruling: 'Use Auth0 via the existing AuthModule.',
      },
    ],
    sections: [
      'Implement the OAuth2 callback handler in backend/src/auth/oauth.controller.ts.',
      'Add JWT validation middleware in backend/src/auth/jwt.middleware.ts.',
    ],
  };

  function makeManager(review: PlanReviewService) {
    return new AgentSessionManager(
      mockEnv,
      mockStore,
      mockDriverStore,
      mockMemory,
      mockApprovals,
      mockLifecycle,
      mockDockerRunner,
      review,
      mockDispatcher,
      mockSurface,
      mockSandboxRows,
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();

    // No existing open job on the thread.
    (mockStore.openJobOnThread as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mockStore.openJob as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_JOB_ID);

    (mockStore.persistPlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      job: {
        id: FAKE_JOB_ID,
        status: 'awaiting_approval',
        title: 'Add OAuth2 login to the API.',
        kind: 'feature',
        team_id: TEAM_ID,
        project_id: PROJECT_ID,
        thread_id: THREAD_ID,
        decision_record_id: FAKE_RECORD_ID,
        created_at: new Date(),
        updated_at: new Date(),
        pr_url: null,
      },
      decisionRecordId: FAKE_RECORD_ID,
    });

    (mockStore.route as ReturnType<typeof vi.fn>).mockResolvedValue({
      channel: 'C-R4GATE',
      threadTs: 'ts-r4gate-001',
    });
    (mockStore.appendAtlasMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const neverResolves = new Promise(() => undefined);
    (mockApprovals.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobId: FAKE_JOB_ID,
      verdict: neverResolves,
    });

    // sandbox available
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_SANDBOX);

    // Build the fake review engine.
    const { engine, calls } = fakeEngine(
      'FINDING: The OAuth callback section brief is too vague — specify which library.',
    );
    reviewEngine = engine;
    reviewEngineCalls = calls;
    planReview = new PlanReviewService(reviewEngine);
  });

  it('FIRST submit_plan: Codex review fires, findings returned in tool response, NO approval card', async () => {
    const manager = makeManager(planReview);
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['submit_plan'](planArgs);

    // One Codex review turn was run.
    expect(reviewEngineCalls).toHaveLength(1);
    expect(reviewEngineCalls[0].engine).toBe('codex');
    expect(reviewEngineCalls[0].mode).toBe('review');

    // Tool response carries the findings (so the session can revise).
    // The message includes the bullet-formatted finding text + instruction to call submit_plan again.
    expect(result).toMatchObject({ ok: true, pendingReview: true });
    expect((result as { message: string }).message).toContain('OAuth callback section brief');
    expect((result as { message: string }).message).toContain('submit_plan');

    // Approval card NOT raised yet — the revision has not happened.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).not.toHaveBeenCalled();
  });

  it('SECOND submit_plan (same job — revision call): guard fires, approval card raised EXACTLY ONCE', async () => {
    const manager = makeManager(planReview);
    const tools = manager.buildTools(fakeStimulus);

    // First call: review runs, findings returned.
    await tools['submit_plan'](planArgs);
    expect(reviewEngineCalls).toHaveLength(1);

    // openJobOnThread now returns the existing job so the second call reuses it.
    (mockStore.openJobOnThread as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_JOB_ID);

    // Second call: the operator's session has revised the plan and calls submit_plan again.
    const result2 = await tools['submit_plan'](planArgs);

    // Guard fired — NO additional review turn.
    expect(reviewEngineCalls).toHaveLength(1);

    // This time, the approval card is raised.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();

    // Tool response is the standard "approval card sent" message (no pendingReview flag).
    expect(result2).toMatchObject({ ok: true, jobId: FAKE_JOB_ID });
    expect((result2 as { pendingReview?: boolean }).pendingReview).toBeUndefined();
  });

  it('clean plan (NO_FINDINGS on first call): proceeds directly to approval card WITHOUT revision round', async () => {
    // Replace the review engine with one that returns NO_FINDINGS.
    const { engine: cleanEngine, calls: cleanCalls } = fakeEngine('NO_FINDINGS');
    const cleanReview = new PlanReviewService(cleanEngine);
    const manager = makeManager(cleanReview);
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['submit_plan'](planArgs);

    // One review turn ran.
    expect(cleanCalls).toHaveLength(1);

    // Approval card fires immediately (no revision needed).
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();

    // Tool response does NOT have pendingReview.
    expect((result as { pendingReview?: boolean }).pendingReview).toBeUndefined();
    expect(result).toMatchObject({ ok: true });
  });

  it('review engine failure: best-effort — approval card fires on first submit_plan (no blocking)', async () => {
    const failReview = new PlanReviewService(failingEngine());
    const manager = makeManager(failReview);
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['submit_plan'](planArgs);

    // Approval card fires (review failure is non-blocking).
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
    expect((result as { pendingReview?: boolean }).pendingReview).toBeUndefined();
  });

  it('no sandbox: proceeds to approval card immediately (review skipped gracefully)', async () => {
    // No sandbox found for the thread.
    (mockLifecycle.findSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const manager = makeManager(planReview);
    const tools = manager.buildTools(fakeStimulus);

    const result = await tools['submit_plan'](planArgs);

    // No review turn (no sandbox to run in).
    expect(reviewEngineCalls).toHaveLength(0);

    // Approval card fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockApprovals.request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });
});

describe('buildRevisionInstruction', () => {
  it('includes the findings text and instructs to call submit_plan again', () => {
    const instruction = buildRevisionInstruction('• Section 1 too vague.\n• Missing decision.');
    expect(instruction).toContain('Section 1 too vague');
    expect(instruction).toContain('Missing decision');
    expect(instruction).toContain('submit_plan');
  });
});
