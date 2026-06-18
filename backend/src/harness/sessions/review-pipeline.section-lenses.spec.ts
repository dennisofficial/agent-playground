import { describe, expect, it, vi } from 'vitest';
import { ReviewPipelineService } from './review-pipeline.service';
import type { Lens } from './section-review.prompts';
import type { Session } from './session-registry.port';

/**
 * Phase 5a — the per-section MULTI-LENS self-review. After a section's last group is built the pipeline
 * runs one read-only review per lens (correctness / SOLID / DRY / conventions) over the section's diff;
 * any lens that returns CHANGES drives the bounded in-session fix loop and ONLY the still-failing lenses
 * are re-run. Engine + git are stubbed; the SUBJECT is the loop control: all four lenses run, the fix
 * loop fires only on changes, re-runs touch only the failing lenses, and exhaustion parks the findings.
 */

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    task: 'Build the backend',
    workspaceId: 'ws-1',
    status: 'idle',
    notifyThread: 'dev:root',
    ownerBot: 'phase_backend',
    team: 'T1',
    project: 'proj',
    engine: 'claude',
    mode: 'investigate',
    turns: 1,
    boardTaskId: 7,
    ...over,
  } as Session;
}

/** Which lens a rendered lens-review prompt is for (each prompt names its own concern). */
function lensOf(prompt: string): Lens {
  if (/CORRECTNESS/.test(prompt)) return 'correctness';
  if (/SOLID/.test(prompt)) return 'solid';
  if (/DRY/.test(prompt)) return 'dry';
  return 'conventions';
}

/** Build the service with a verdict-per-lens map the fix loop can mutate (a "fix" flips a lens to pass). */
function build(opts: {
  verdicts: Partial<Record<Lens, 'pass' | 'changes'>>;
  /** Lenses a fix turn (resumeInternal) flips to 'pass' — simulates the fix resolving them. */
  fixResolves?: Lens[];
}) {
  const verdicts: Record<Lens, 'pass' | 'changes'> = {
    correctness: opts.verdicts.correctness ?? 'pass',
    solid: opts.verdicts.solid ?? 'pass',
    dry: opts.verdicts.dry ?? 'pass',
    conventions: opts.verdicts.conventions ?? 'pass',
  };

  // Each read-only lens review → its verdict from the live map (so a later fix changes the re-run).
  const engineRun = vi.fn(async (o: { task: string }) => {
    const lens = lensOf(o.task);
    return { result: `findings for ${lens}\nVERDICT: ${verdicts[lens].toUpperCase()}` };
  });
  // TurnExecutor double: Phase 7 routes LOCAL (isContainerized=false) → engineRun(args), the verbatim
  // local-branch delegation, so the lens-review assertions stay byte-identical.
  const turnExecutor = {
    run: (_ctx: unknown, _name: unknown, args: unknown) => engineRun(args as never),
  } as never;

  const bot = {
    id: 'phase_backend',
    capabilities: () => [
      { name: 'self_review', spec: () => ({ engine: 'codex', systemPrompt: 'sp' }) },
    ],
    executeEngine: () => ({ engine: 'claude', systemPrompt: 'sp' }),
  };
  const employees = {
    byId: () => bot,
    context: () => ({}),
    teamLead: () => bot,
  } as never;

  const credCtx = { run: (_c: unknown, fn: () => unknown) => fn() } as never;
  const creds = { resolve: async () => ({ anthropic: 'k', openai: 'k' }) } as never;

  const workspace = { id: 'ws-1', path: '/tmp/ws', baseRef: 'base', branch: 'feat' };
  const ownerDiff = vi.fn(async () => ({ range: 'base...feat', files: ['a.ts'] }));
  const workspaces = {
    get: () => workspace,
    projectRecordFor: async () => ({ defaultBranch: 'main' }),
    ownerDiff,
  } as never;

  const board = {
    get: async () => ({ title: 'Backend', description: 'the api' }),
  } as never;

  const noteAdd = vi.fn(async () => ({ id: 1 }));
  const notes = { add: noteAdd } as never;
  const boardEmit = vi.fn();
  const boardEvents = { emit: boardEmit } as never;

  // A fix turn flips the named lenses to pass (the fix worked).
  const resumeInternal = vi.fn(async () => {
    for (const l of opts.fixResolves ?? []) verdicts[l] = 'pass';
    return makeSession();
  });
  const runner = { resumeInternal } as never;

  const svc = new ReviewPipelineService(
    turnExecutor,
    employees,
    credCtx,
    creds,
    workspaces,
    {} as never, // tokens — unused
    {} as never, // github — unused
    board,
    {} as never, // plans — unused
    notes,
    boardEvents,
    runner,
    {} as never, // env — unused
    {} as never, // sessions — unused
  );
  return { svc, engineRun, resumeInternal, noteAdd, boardEmit, ownerDiff };
}

/** The lenses reviewed across all engine runs, in call order. */
const reviewedLenses = (engineRun: { mock: { calls: unknown[][] } }): Lens[] =>
  engineRun.mock.calls.map((c) => lensOf((c[0] as { task: string }).task));

describe('ReviewPipelineService.reviewSectionLenses (Phase 5a)', () => {
  it('all lenses clean: runs each of the four once, no fix loop, no findings', async () => {
    const f = build({ verdicts: {} }); // all pass
    const out = await f.svc.reviewSectionLenses(makeSession(), { sectionName: 'backend' });
    expect(out).toEqual({ ok: true, findings: [] });
    expect(reviewedLenses(f.engineRun).sort()).toEqual([
      'conventions',
      'correctness',
      'dry',
      'solid',
    ]);
    expect(f.resumeInternal).not.toHaveBeenCalled();
  });

  it('a changes lens drives ONE fix pass and re-runs ONLY the failing lens', async () => {
    const f = build({ verdicts: { correctness: 'changes' }, fixResolves: ['correctness'] });
    const out = await f.svc.reviewSectionLenses(makeSession(), { sectionName: 'backend' });
    expect(out.ok).toBe(true);
    // Pass 0 reviewed all four; the fix turn fired once; pass 1 re-ran ONLY correctness.
    expect(f.resumeInternal).toHaveBeenCalledTimes(1);
    expect(reviewedLenses(f.engineRun)).toEqual([
      'correctness',
      'solid',
      'dry',
      'conventions',
      'correctness', // re-run of the one failing lens only
    ]);
    expect(out.findings.length).toBe(1);
  });

  it('nothing-to-review (empty diff) short-circuits before any engine run', async () => {
    const f = build({ verdicts: { correctness: 'changes' } });
    f.ownerDiff.mockResolvedValueOnce({ range: '', files: [] });
    const out = await f.svc.reviewSectionLenses(makeSession(), { sectionName: 'backend' });
    expect(out).toEqual({ ok: true, findings: [] });
    expect(f.engineRun).not.toHaveBeenCalled();
  });

  it('exhausts the fix budget: parks the findings as a note and narrates self-review-failed', async () => {
    // dry never resolves → still failing after MAX_FIX_PASSES (2) fix turns.
    const f = build({ verdicts: { dry: 'changes' } });
    const out = await f.svc.reviewSectionLenses(makeSession(), { sectionName: 'backend' });
    expect(out.ok).toBe(false);
    expect(f.resumeInternal).toHaveBeenCalledTimes(2); // MAX_FIX_PASSES
    // 4 (pass 0) + 1 (pass 1, dry only) + 1 (pass 2, dry only) = 6 reviews.
    expect(f.engineRun).toHaveBeenCalledTimes(6);
    expect(f.noteAdd).toHaveBeenCalledWith(
      'T1',
      7,
      'phase_backend',
      expect.stringContaining('self-review still flags'),
    );
    const failed = f.boardEmit.mock.calls
      .map((c) => c[0] as { kind: string; reason?: string })
      .filter((e) => e.kind === 'self-review-failed');
    expect(failed.length).toBe(1);
    expect(failed[0].reason).toContain('dry');
  });
});
