import { describe, expect, it, vi } from 'vitest';
import { PipelineRunnerService } from './pipeline-runner.service';
import {
  FakeCodingStore,
  FakeNoteStore,
  FakePhaseStore,
  FakeReviewStore,
  FakeRunStore,
  FakeSectionStore,
  type Row,
} from './pipeline-runner.test-fakes';

/**
 * Durable ticket context at dispatch. An engine session can't open the ticket from its worktree (no
 * get_ticket), so the runner INLINES the ticket's durable context into each dispatch seed:
 *  - section plan ← the freeform research/decision notes (machine-authored notes excluded);
 *  - bugfix ← the ticket title/description (the bug report) + research notes;
 *  - fixup ← the latest stage-decision findings note (+ Atlas's optional guidance overlay).
 * Driven with the in-memory fakes (no engines/DB); the seed prompt reaches the spy as
 * openStageSession({ task }).
 */

function build() {
  const runs = new FakeRunStore();
  const sectionStore = new FakeSectionStore();
  const phaseStore = new FakePhaseStore();
  const codingStore = new FakeCodingStore();
  const reviewStore = new FakeReviewStore();
  const notes = new FakeNoteStore();
  const sessionRows = new Map<string, Row>();
  let sessSeq = 0;
  const openStageSession = vi.fn(async (opts: Row) => {
    const session: Row = { id: `sess-${++sessSeq}`, status: 'idle', ...opts };
    sessionRows.set(session.id as string, session);
    return session;
  });
  const closeSession = vi.fn(async (id: string, _o?: { logWork?: boolean }) => {
    const r = sessionRows.get(id);
    if (!r || r.status === 'closed') return { ok: false, reason: 'gone' };
    r.status = 'closed';
    return { ok: true };
  });
  // No turns survive a restart, so the boot-recovery liveness guard always reads false here.
  const runner = { openStageSession, closeSession, isTurnInFlight: () => false };
  const sessions = {
    onUpdate: vi.fn(),
    async get(id: string): Promise<Row | undefined> {
      const r = sessionRows.get(id);
      return r ? { ...r } : undefined;
    },
  };
  const board = {
    update: vi.fn(async (..._a: unknown[]) => undefined),
    get: vi.fn(async (..._a: unknown[]): Promise<Row | undefined> => undefined),
  };
  const employees = {
    byId: (id: string) => ({ id }),
    teamLead: () => ({ id: 'atlas' }),
  };
  const plans = {
    attach: vi.fn(async (..._a: unknown[]) => undefined),
    approve: vi.fn(async (..._a: unknown[]) => undefined),
  };
  const proposals = { propose: vi.fn(async () => ({ ok: true })) };
  const review = {
    shipTask: vi.fn(async () => ({ ok: true, prUrl: 'http://pr/1' })),
    reviewSectionLenses: vi.fn(async () => ({ ok: true, findings: [] as string[] })),
    reviewFullImplementation: vi.fn(async () => ({
      verdict: 'pass' as const,
      findings: '',
    })),
  };
  const boardEvents = { emit: vi.fn(), onEvent: vi.fn() };
  const worktrees = { get: vi.fn(() => ({ path: '' })) };

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
    worktrees as never,
    phaseStore as never,
    codingStore as never,
    reviewStore as never,
    notes as never,
  );
  return { svc, runs, runner, notes, board };
}

type Built = ReturnType<typeof build>;
type Reopen = { reopenCurrentStep: (r: Row) => Promise<void> };

const TEAM = 'T1';
const startFeature = (svc: PipelineRunnerService, task: number) =>
  svc.start({
    team: TEAM,
    project: 'proj',
    taskId: task,
    worktreeId: `wt-${task}`,
    notifyThread: 'thread',
    kind: 'feature',
    sections: [{ name: 'backend', role: 'phase_backend' }],
  });
const seeds = (runner: Built['runner'], mode: 'plan' | 'execute') =>
  runner.openStageSession.mock.calls
    .filter((c) => c[0].mode === mode)
    .map((c) => c[0].task as string);

describe('PipelineRunnerService — durable ticket context at dispatch', () => {
  it('seeds the section plan with research notes and excludes machine-authored notes', async () => {
    const { svc, runner, notes } = build();
    const task = 201;
    await notes.add(
      TEAM,
      task,
      'atlas',
      'RESEARCH: the upload flow uses S3 presigned URLs — reuse PresignService in foo.ts.',
    );
    // Machine notes that must NOT leak into the generic context:
    await notes.add(
      TEAM,
      task,
      'dennis',
      'Requested changes on the proposal (via the Slack approval card): use Postgres not Mongo.',
    );
    await notes.add(
      TEAM,
      task,
      'atlas',
      "Pipeline backend ('backend') flagged a blocking issue:\n\nThe migration drops a live column.",
    );
    await startFeature(svc, task);

    const [seed] = seeds(runner, 'plan');
    expect(seed).toContain('CONTEXT captured on the ticket');
    expect(seed).toContain('PresignService');
    expect(seed).not.toContain('use Postgres not Mongo'); // changes-requested verdict excluded
    expect(seed).not.toContain('migration drops a live column'); // stage-findings excluded
  });

  it('omits the CONTEXT block when the ticket has no research notes', async () => {
    const { svc, runner } = build();
    const task = 202;
    await startFeature(svc, task);

    const [seed] = seeds(runner, 'plan');
    expect(seed).not.toContain('CONTEXT captured on the ticket');
  });

  it('inlines the ticket title/description and research notes into a bugfix seed', async () => {
    const { svc, runner, notes, board } = build();
    const task = 301;
    board.get.mockResolvedValue({
      title: 'Upload fails on big files',
      description: 'Repro: upload >2GB → 500. Stack trace in logs.',
    });
    await notes.add(
      TEAM,
      task,
      'atlas',
      'RESEARCH: the multipart threshold is hardcoded at 2GB in upload.service.ts.',
    );
    await svc.start({
      team: TEAM,
      project: 'proj',
      taskId: task,
      worktreeId: `wt-${task}`,
      notifyThread: 'thread',
      kind: 'bugfix',
      role: 'phase_backend',
    });

    const [seed] = seeds(runner, 'execute');
    expect(seed).toContain('Upload fails on big files');
    expect(seed).toContain('Repro: upload >2GB');
    expect(seed).toContain('multipart threshold is hardcoded');
  });

  it('inlines the stage-decision findings into a fixup seed (dispatch and boot reopen)', async () => {
    const { svc, runs, runner, notes } = build();
    const task = 401;
    await startFeature(svc, task);
    const run = (await runs.getByTask(TEAM, task))!;
    // What pauseForStageDecision leaves behind, plus the paused state dispatch_fixup_session requires.
    await notes.add(
      TEAM,
      task,
      'atlas',
      "Pipeline full-impl review flagged a blocking issue:\n\nThe FE calls /api/upload but the BE route is /api/uploads — they don't match.",
    );
    await runs.update(TEAM, run.id as string, {
      status: 'paused',
      planningSubstep: 'stage_decision',
    });

    const r = await svc.dispatchFixup(TEAM, task, 'prioritize the route mismatch');
    expect(r.ok).toBe(true);
    const dispatchSeed = seeds(runner, 'execute').slice(-1)[0];
    expect(dispatchSeed).toContain("they don't match");
    expect(dispatchSeed).toContain('prioritize the route mismatch'); // guidance overlay
    expect(dispatchSeed).not.toContain('Read the ticket and its latest notes'); // dead line gone

    // Boot recovery: a fixup session died on restart. reopenCurrentStep re-inlines the findings from
    // the note (guidance is lost on restart — the findings are the authoritative input).
    await runs.update(TEAM, run.id as string, {
      planningSubstep: 'fixup',
      sessionId: 'dead-sess',
    });
    const recovered = (await runs.getByTask(TEAM, task))!;
    await (svc as unknown as Reopen).reopenCurrentStep(recovered);
    const reopenSeed = seeds(runner, 'execute').slice(-1)[0];
    expect(reopenSeed).toContain("they don't match");
  });
});
