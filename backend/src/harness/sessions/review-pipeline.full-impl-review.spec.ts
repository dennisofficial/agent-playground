import { describe, expect, it, vi } from 'vitest';
import { localGitProvider } from '../workspaces/workspace-git.test-util';
import { PipelineRunnerService } from './pipeline-runner.service';
import { ReviewPipelineService } from './review-pipeline.service';
import {
  FakeCodingStore,
  FakeNoteStore,
  FakePhaseStore,
  FakeReviewStore,
  FakeRunStore,
  FakeSectionStore,
  type Row,
} from './pipeline-runner.test-fakes';
import { fakeSandboxRegistry } from '../workspaces/workspace-git.test-util';

/**
 * Phase 5b — the ticket-level full-implementation review at the PR gate. Two halves: (1) the runner's
 * handlePrGate ROUTING — a `pass` ships (advisory findings ride the PR comment), a `changes` pauses the
 * run and wakes Atlas with a stage-decision instead of shipping, and a bugfix skips the review entirely;
 * (2) ReviewPipelineService.reviewFullImplementation itself — verdict + findings over the ticket range.
 */

const TEAM = 'T1';

// ── (1) handlePrGate routing (runner) ─────────────────────────────────────────

function buildRunner(reviewFull: {
  verdict: 'pass' | 'changes';
  findings: string;
}) {
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const phaseStore = new FakePhaseStore();
  const codingStore = new FakeCodingStore();
  const reviewStore = new FakeReviewStore();
  const notes = new FakeNoteStore();
  const runner = {
    openStageSession: vi.fn(),
    closeSession: vi.fn(async () => ({ ok: true })),
  };
  const sessions = { onUpdate: vi.fn(), get: vi.fn(async () => undefined) };
  const board = { update: vi.fn(async () => undefined), get: vi.fn() };
  const employees = { byId: (id: string) => ({ id }), teamLead: () => ({ id: 'atlas' }) };
  const plans = { attach: vi.fn(), approve: vi.fn() };
  const proposals = { propose: vi.fn(async () => ({ ok: true })) };
  const shipTask = vi.fn(async () => ({ ok: true, prUrl: 'http://pr/1' }));
  const reviewFullImplementation = vi.fn(async () => reviewFull);
  const review = {
    shipTask,
    reviewSectionLenses: vi.fn(async () => ({ ok: true, findings: [] })),
    reviewFullImplementation,
  };
  const boardEvents = { emit: vi.fn(), onEvent: vi.fn() };
  const workspaces = { get: vi.fn(() => ({ path: '/tmp/ws' })) };
  const svc = new PipelineRunnerService(
    runs as never,
    sectionStore as never,
    runner as never,
    sessions as never,
    board as never,
    employees as never,
    plans as never,
    proposals as never,
    review as never,
    boardEvents as never,
    phaseStore as never,
    codingStore as never,
    reviewStore as never,
    notes as never,
    localGitProvider() as never,
  );
  return { svc, runs, shipTask, reviewFullImplementation, boardEvents, notes };
}

const callPrGate = (svc: PipelineRunnerService, run: Row) =>
  (svc as never as { handlePrGate: (r: Row) => Promise<void> }).handlePrGate(run);

const newFeatureRun = async (runs: FakeRunStore, taskId: number): Promise<Row> =>
  runs.create({
    team: TEAM,
    taskId,
    pipeline: 'dynamic',
    kind: 'feature',
    status: 'running',
    workspaceId: 'ws-1',
    notifyThread: 'thread',
    project: 'proj',
  });

const stageDecisions = (boardEvents: { emit: { mock: { calls: unknown[][] } } }) =>
  boardEvents.emit.mock.calls
    .map((c) => c[0] as { kind: string; findings?: string })
    .filter((e) => e.kind === 'stage-decision');

describe('handlePrGate — full-implementation review routing (Phase 5b)', () => {
  it('pass → ships, advisory findings ride the PR comment, run done', async () => {
    const f = buildRunner({ verdict: 'pass', findings: 'minor nit, advisory' });
    const run = await newFeatureRun(f.runs, 7);
    await callPrGate(f.svc, run);
    expect(f.reviewFullImplementation).toHaveBeenCalled();
    expect(f.shipTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 7, findings: 'minor nit, advisory' }),
    );
    expect((await f.runs.getByTask(TEAM, 7))?.status).toBe('done');
    expect(stageDecisions(f.boardEvents)).toEqual([]);
  });

  it('changes → does NOT ship; pauses + emits a stage-decision with the findings', async () => {
    const f = buildRunner({ verdict: 'changes', findings: 'contract mismatch at the BE/FE seam' });
    const run = await newFeatureRun(f.runs, 8);
    await callPrGate(f.svc, run);
    expect(f.shipTask).not.toHaveBeenCalled();
    const decisions = stageDecisions(f.boardEvents);
    expect(decisions.length).toBe(1);
    expect(decisions[0].findings).toContain('contract mismatch');
    const paused = await f.runs.getByTask(TEAM, 8);
    expect(paused?.status).toBe('paused');
    expect(paused?.planningSubstep).toBe('stage_decision');
    // Findings parked durably (survive a restart — the seed event won't re-fire).
    expect((await f.notes.listForTask(TEAM, 8)).notes.length).toBe(1);
  });

  it('a bugfix run skips the full-impl review and ships directly', async () => {
    const f = buildRunner({ verdict: 'changes', findings: 'should not run' });
    const run = await f.runs.create({
      team: TEAM,
      taskId: 9,
      pipeline: 'bugfix',
      kind: 'bugfix',
      status: 'running',
      workspaceId: 'ws-9',
      notifyThread: 'thread',
      project: 'proj',
    });
    await callPrGate(f.svc, run);
    expect(f.reviewFullImplementation).not.toHaveBeenCalled();
    expect(f.shipTask).toHaveBeenCalled();
  });
});

// ── (2) reviewFullImplementation (ReviewPipelineService) ───────────────────────

function buildReviewSvc(verdictText: string, files: string[] = ['a.ts']) {
  const engineRun = vi.fn(async () => ({ result: verdictText }));
  // TurnExecutor double: Phase 7 routes LOCAL (isContainerized=false) → engineRun(args), the verbatim
  // local-branch delegation, so the runReview assertions stay byte-identical.
  const turnExecutor = {
    run: (_ctx: unknown, _name: unknown, _args: unknown) => engineRun(),
  } as never;
  const bot = {
    id: 'atlas',
    capabilities: () => [],
    executeEngine: () => ({ engine: 'codex', systemPrompt: 'sp' }),
  };
  const employees = { byId: () => bot, teamLead: () => bot, context: () => ({}) } as never;
  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() } as never;
  const creds = { resolve: async () => ({ anthropic: 'k', openai: 'k' }) } as never;
  const reviewRange = vi.fn(async () => ({ range: 'base...feat', files, baseBranch: 'main' }));
  const workspaces = {
    get: () => ({ id: 'ws-1', name: 'ws-1', branch: 'feat', team: 't', project: 'p', ownerBot: 'alex' }),
    reviewRange,
  } as never;
  const board = { get: async () => ({ title: 'Feature', description: 'desc' }) } as never;
  const svc = new ReviewPipelineService(
    turnExecutor,
    employees,
    credCtx,
    creds,
    workspaces,
    localGitProvider(workspaces, { containerizedIds: new Set(['ws-1']) }),
    {} as never,
    {} as never,
    board,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, engineRun };
}

describe('ReviewPipelineService.reviewFullImplementation', () => {
  it('parses a PASS verdict and returns the findings', async () => {
    const f = buildReviewSvc('Looks coherent across sections.\nVERDICT: PASS');
    const out = await f.svc.reviewFullImplementation({
      team: TEAM,
      taskId: 7,
      workspaceId: 'ws-1',
    });
    expect(out.verdict).toBe('pass');
    expect(out.findings).toContain('coherent');
    expect(f.engineRun).toHaveBeenCalledTimes(1);
  });

  it('parses a CHANGES verdict', async () => {
    const f = buildReviewSvc('Seam defect in X.\nVERDICT: CHANGES');
    const out = await f.svc.reviewFullImplementation({
      team: TEAM,
      taskId: 7,
      workspaceId: 'ws-1',
    });
    expect(out.verdict).toBe('changes');
  });

  it('empty diff short-circuits to a clean pass with no engine run', async () => {
    const f = buildReviewSvc('unused', []);
    const out = await f.svc.reviewFullImplementation({
      team: TEAM,
      taskId: 7,
      workspaceId: 'ws-1',
    });
    expect(out).toEqual({ verdict: 'pass', findings: '' });
    expect(f.engineRun).not.toHaveBeenCalled();
  });
});
