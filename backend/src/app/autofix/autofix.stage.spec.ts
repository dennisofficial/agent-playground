import { describe, expect, it, vi } from 'vitest';
import { AutoFixStage } from './autofix.stage';
import type { EngineRunnerPort } from '../engine';
import type { LocalGitService } from '../git';
import type { TurnHarnessFactory } from '../surface/turn-harness.service';
import type { AutoFixContext, ReviewLens } from './autofix.types';

/**
 * A stub {@link TurnHarnessFactory}. `create` records the `{lane, metaTag}` it was called with and returns a
 * harness whose `onEvent`/`finish`/`abort` are spies — so streaming tests can assert the lane/meta contract
 * without a real live-turn store. For the non-streaming tests it's an unused throwaway (`create` never fires).
 */
function mockHarness(): {
  factory: TurnHarnessFactory;
  create: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const finish = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const harness = { onEvent: vi.fn(), finish, abort, emitPrompt: vi.fn(async () => {}) };
  const create = vi.fn(() => harness);
  return { factory: { create } as unknown as TurnHarnessFactory, create, finish, abort };
}

/** A context that supplies its own diff/changedFiles so the stage never shells out to git for review. */
const ctx: AutoFixContext = {
  worktreePath: '/tmp/wt',
  sandboxKey: 'acme--feat',
  diff: 'diff --git a/x.ts b/x.ts\n+const y = 1;',
  changedFiles: ['src/x.ts'],
  intent: 'add a y constant',
  label: 'backend',
};

/** Two narrow lenses so the fan-out width is deterministic in tests. */
const LENSES: ReviewLens[] = [
  { id: 'l1', label: 'Lens one', focus: 'f1' },
  { id: 'l2', label: 'Lens two', focus: 'f2' },
];

/** A review report JSON helper. */
function reportWith(findings: Array<Record<string, unknown>>): string {
  return '```json\n' + JSON.stringify({ findings }) + '\n```';
}

/**
 * Build a mocked EngineRunner whose `run` dispatches on the turn mode: review turns return the queued
 * per-lens reports (matched by the `--review-<lensId>` sandbox key); the execute (fix) turn returns a
 * fixed report. Records all calls for assertions.
 */
function mockEngine(opts: {
  reviewReports: Record<string, string>;
  fixReport?: string;
}): {
  engine: EngineRunnerPort;
  calls: Array<{ mode: string; sandboxKey: string; richStream?: boolean; hasOnEvent: boolean }>;
} {
  const calls: Array<{ mode: string; sandboxKey: string; richStream?: boolean; hasOnEvent: boolean }> = [];
  const run = vi.fn(
    async (args: { mode: string; sandboxKey: string; richStream?: boolean; onEvent?: unknown }) => {
      calls.push({
        mode: args.mode,
        sandboxKey: args.sandboxKey,
        richStream: args.richStream,
        hasOnEvent: typeof args.onEvent === 'function',
      });
      if (args.mode === 'execute') {
      return { result: opts.fixReport ?? 'fixed finding 1', sessionId: 'fix-sess' };
    }
    // review turn — pick the report by the lens embedded in the sandbox key.
    const lensId = args.sandboxKey.split('--review-')[1];
    return { result: opts.reviewReports[lensId] ?? reportWith([]), sessionId: `rev-${lensId}` };
  });
  return { engine: { run } as unknown as EngineRunnerPort, calls };
}

/** A mocked LocalGitService — `hasChanges` + `commitAll` are the only surface the stage touches. */
function mockGit(opts: { hasChanges?: boolean; sha?: string | null }): {
  git: LocalGitService;
  commitAll: ReturnType<typeof vi.fn>;
} {
  const commitAll = vi.fn(async () => opts.sha ?? 'abc1234def');
  const git = {
    hasChanges: vi.fn(async () => opts.hasChanges ?? true),
    commitAll,
  } as unknown as LocalGitService;
  return { git, commitAll };
}

describe('AutoFixStage — fan-out + aggregate + fix + commit', () => {
  it('fans out one review pass PER lens (N passes) and aggregates findings', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', file: 'src/x.ts', title: 'finding A' }]),
        l2: reportWith([{ severity: 'medium', file: 'src/y.ts', title: 'finding B' }]),
      },
    });
    const { git } = mockGit({ hasChanges: true, sha: 'sha-1' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    const reviewCalls = calls.filter((c) => c.mode === 'review');
    expect(reviewCalls).toHaveLength(2); // N = number of lenses
    expect(summary.lensesRun).toEqual(['l1', 'l2']);
    expect(summary.findings.map((f) => f.title).sort()).toEqual(['finding A', 'finding B']);
    expect(summary.clean).toBe(false);
  });

  it('dedupes findings the same finding flagged by multiple lenses', async () => {
    const { engine } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'low', file: 'src/x.ts', title: 'Missing guard.' }]),
        l2: reportWith([{ severity: 'high', file: 'src/x.ts', title: 'missing guard' }]),
      },
    });
    const { git } = mockGit({ hasChanges: true, sha: 'sha-1' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].severity).toBe('high'); // highest wins
    expect(summary.findings[0].lens.split('+').sort()).toEqual(['l1', 'l2']);
  });

  it('applies fixes via an execute turn and commits them', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', file: 'src/x.ts', title: 'finding A', detail: 'fix it' }]),
        l2: reportWith([]),
      },
      fixReport: 'I fixed finding A.',
    });
    const { git, commitAll } = mockGit({ hasChanges: true, sha: 'commitsha1' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(calls.some((c) => c.mode === 'execute')).toBe(true);
    expect(commitAll).toHaveBeenCalledTimes(1);
    expect(summary.fixesAttempted).toBe(true);
    expect(summary.fixReport).toBe('I fixed finding A.');
    expect(summary.commits).toEqual([
      { sha: 'commitsha1', message: expect.stringContaining('thread review fixes') },
    ]);
  });

  it('PR-tail mode tags the commit message + summary mode', async () => {
    const { engine } = mockEngine({
      reviewReports: { l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]), l2: reportWith([]) },
    });
    const { git, commitAll } = mockGit({ hasChanges: true, sha: 'prsha' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixPullRequest(ctx, { lenses: LENSES });

    expect(summary.mode).toBe('pull_request');
    expect(commitAll).toHaveBeenCalledWith(
      ctx.worktreePath,
      expect.stringContaining('PR-tail review fixes'),
    );
  });

  it('does NOT attempt a fix when all findings are below fixMinSeverity', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'low', file: 'src/x.ts', title: 'nit' }]),
        l2: reportWith([]),
      },
    });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES, fixMinSeverity: 'medium' });

    expect(calls.some((c) => c.mode === 'execute')).toBe(false);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.fixesAttempted).toBe(false);
    expect(summary.findings).toHaveLength(1); // still reported
  });

  it('report-only (applyFixes:false) reviews but never writes/commits', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: { l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]), l2: reportWith([]) },
    });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES, applyFixes: false });

    expect(calls.some((c) => c.mode === 'execute')).toBe(false);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.fixesAttempted).toBe(false);
    expect(summary.findings).toHaveLength(1);
  });

  it('is idempotent: a clean re-run finds nothing, attempts no fix, commits nothing', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: { l1: reportWith([]), l2: reportWith([]) },
    });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.clean).toBe(true);
    expect(summary.findings).toEqual([]);
    expect(calls.some((c) => c.mode === 'execute')).toBe(false);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.commits).toEqual([]);
  });

  it('skips the lens fan-out entirely when nothing changed (0 changed files)', async () => {
    // A thread that only investigated commits nothing → the derived change set is empty. The stage must
    // short-circuit: no review turns, no fix turn — a clean summary with zero wasted LLM calls. (`/tmp`
    // is not a git repo, so the diff derivation yields [].)
    const { engine, calls } = mockEngine({ reviewReports: {} });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(
      { ...ctx, worktreePath: '/tmp', diff: '', changedFiles: [] },
      { lenses: LENSES },
    );

    expect(calls).toEqual([]); // NO engine turns at all (no review, no fix)
    expect(summary.lensesRun).toEqual([]);
    expect(summary.findings).toEqual([]);
    expect(summary.clean).toBe(true);
    expect(commitAll).not.toHaveBeenCalled();
  });

  it('produces no commit when the fix turn changes nothing (git.hasChanges false)', async () => {
    const { engine } = mockEngine({
      reviewReports: { l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]), l2: reportWith([]) },
    });
    const { git, commitAll } = mockGit({ hasChanges: false });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.fixesAttempted).toBe(true); // the fix turn ran
    expect(commitAll).not.toHaveBeenCalled(); // but nothing changed → no commit
    expect(summary.commits).toEqual([]);
  });

  it('a single failed review pass is dropped, not fatal (other lenses still aggregate)', async () => {
    const calls: Array<{ mode: string; sandboxKey: string }> = [];
    const run = vi.fn(async (args: { mode: string; sandboxKey: string }) => {
      calls.push({ mode: args.mode, sandboxKey: args.sandboxKey });
      if (args.mode === 'execute') return { result: 'fixed' };
      const lensId = args.sandboxKey.split('--review-')[1];
      if (lensId === 'l1') throw new Error('engine boom');
      return { result: reportWith([{ severity: 'high', file: 'a.ts', title: 'survivor' }]) };
    });
    const engine = { run } as unknown as EngineRunnerPort;
    const { git } = mockGit({ hasChanges: true, sha: 's' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.findings.map((f) => f.title)).toEqual(['survivor']);
  });

  it('respects the configured concurrency cap (batched fan-out)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn(async (args: { mode: string; sandboxKey: string }) => {
      if (args.mode === 'review') {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }
      return { result: reportWith([]) };
    });
    const engine = { run } as unknown as EngineRunnerPort;
    const { git } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const lenses: ReviewLens[] = Array.from({ length: 5 }, (_, i) => ({
      id: `lens${i}`,
      label: `L${i}`,
      focus: 'f',
    }));
    await stage.autofixThread(ctx, { lenses, concurrency: 2 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe('AutoFixStage — streaming onto the transcript spine', () => {
  /** A ctx carrying a streaming identity → each turn rides an `autofix:*` lane. */
  const streamCtx: AutoFixContext = {
    ...ctx,
    jobId: 'job-1',
    channel: 'repo-1',
    autofixId: 'thread-1',
    scope: 'thread',
  };

  it('streams each lens + the fix turn on its own lane with the meta contract', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', file: 'src/x.ts', title: 'A', detail: 'fix it' }]),
        l2: reportWith([]),
      },
      fixReport: 'fixed A',
    });
    const { git } = mockGit({ hasChanges: true, sha: 'sha-1' });
    const h = mockHarness();
    const stage = new AutoFixStage(engine, git, h.factory);

    await stage.autofixThread(streamCtx, { lenses: LENSES });

    // A harness per turn: 2 review lenses + 1 fix turn, each on its own sub-lane.
    const byLane = new Map<string, { jobId: string; channel: string; metaTag: unknown }>(
      h.create.mock.calls.map((c) => [c[0].lane, c[0]]),
    );
    expect([...byLane.keys()].sort()).toEqual([
      'autofix:thread-1:fix',
      'autofix:thread-1:l1',
      'autofix:thread-1:l2',
    ]);
    expect(byLane.get('autofix:thread-1:l1')).toMatchObject({
      jobId: 'job-1',
      channel: 'repo-1',
      metaTag: { autofixId: 'thread-1', scope: 'thread', lensId: 'l1' },
    });
    expect(byLane.get('autofix:thread-1:fix')!.metaTag).toEqual({
      autofixId: 'thread-1',
      scope: 'thread',
      fixTurn: true,
    });
    // Every engine turn opted into rich streaming + forwarded events; each harness was finished.
    expect(calls.every((c) => c.richStream === true && c.hasOnEvent)).toBe(true);
    expect(h.finish).toHaveBeenCalledTimes(3);
  });

  it('does NOT create a harness (nor richStream) when the ctx carries no streaming identity', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: { l1: reportWith([{ severity: 'high', file: 'a.ts', title: 'A' }]), l2: reportWith([]) },
    });
    const { git } = mockGit({ hasChanges: true, sha: 's' });
    const h = mockHarness();
    const stage = new AutoFixStage(engine, git, h.factory);

    await stage.autofixThread(ctx, { lenses: LENSES }); // ctx has no jobId/channel

    expect(h.create).not.toHaveBeenCalled();
    expect(calls.every((c) => !c.richStream)).toBe(true);
  });

  it('aborts (not finishes) the lens harness when a review pass throws', async () => {
    const run = vi.fn(
      async (args: { mode: string; sandboxKey: string; richStream?: boolean; onEvent?: unknown }) => {
        if (args.mode === 'review' && args.sandboxKey.endsWith('--review-l1')) {
          throw new Error('engine boom');
        }
        return { result: reportWith([]) };
      },
    );
    const engine = { run } as unknown as EngineRunnerPort;
    const { git } = mockGit({});
    const h = mockHarness();
    const stage = new AutoFixStage(engine, git, h.factory);

    await stage.autofixThread(streamCtx, { lenses: LENSES });

    // l1 threw → its harness aborted; l2 succeeded → finished. Never both for one turn.
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
  });
});
