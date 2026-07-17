import type { EngineHomeKey, EngineRunnerPort } from '@shared/engine';
import { describe, expect, it, vi } from 'vitest';
import type { LocalGitService } from '../../git';
import type { TurnHarnessFactory } from '../../surface/turn-harness.service';
import { lensById } from '../autofix-lenses';
import { AutoFixStage } from '../autofix.stage';
import type { AutoFixContext, ReviewLens } from '../autofix.types';

function mockHarness(): {
  factory: TurnHarnessFactory;
  create: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  const finish = vi.fn(async () => {});
  const abort = vi.fn(async () => {});
  const harness = {
    onEvent: vi.fn(),
    finish,
    abort,
    emitPrompt: vi.fn(async () => {}),
  };
  const create = vi.fn(() => harness);
  return {
    factory: { create } as unknown as TurnHarnessFactory,
    create,
    finish,
    abort,
  };
}

const ctx: AutoFixContext = {
  worktreePath: '/tmp/wt',
  sandboxKey: {
    orgId: 'acme',
    repoId: 'atlas',
    jobId: 'feat',
    type: 'autofix',
  },
  gitRange: 'abc123..HEAD',
  changedFiles: ['src/x.ts'],
  intent: 'add a y constant',
  label: 'backend',
};

const LENSES: ReviewLens[] = [
  { id: 'l1', label: 'Lens one', focus: 'f1' },
  { id: 'l2', label: 'Lens two', focus: 'f2' },
];

function reportWith(findings: Array<Record<string, unknown>>): string {
  return '```json\n' + JSON.stringify({ findings }) + '\n```';
}

function reviewLensId(sandboxKey: EngineHomeKey): string | undefined {
  return sandboxKey.subId?.startsWith('review-')
    ? sandboxKey.subId.slice('review-'.length)
    : undefined;
}

type EngineCall = {
  mode: string;
  engine?: string;
  sandboxKey: EngineHomeKey;
  richStream?: boolean;
  hasOnEvent: boolean;
  modelReasoningEffort?: string;
};

function mockEngine(opts: { reviewReports: Record<string, string>; fixReport?: string }): {
  engine: EngineRunnerPort;
  calls: EngineCall[];
} {
  const calls: EngineCall[] = [];
  const run = vi.fn(
    async (args: {
      mode: string;
      engine?: string;
      sandboxKey: EngineHomeKey;
      richStream?: boolean;
      onEvent?: unknown;
      modelReasoningEffort?: string;
    }) => {
      calls.push({
        mode: args.mode,
        engine: args.engine,
        sandboxKey: args.sandboxKey,
        richStream: args.richStream,
        hasOnEvent: typeof args.onEvent === 'function',
        modelReasoningEffort: args.modelReasoningEffort,
      });
      if (args.mode === 'execute') {
        return {
          result: opts.fixReport ?? 'fixed finding 1',
          sessionId: 'fix-sess',
        };
      }
      const lensId = reviewLensId(args.sandboxKey);
      return {
        result: opts.reviewReports[lensId ?? ''] ?? reportWith([]),
        sessionId: `rev-${lensId}`,
      };
    },
  );
  return { engine: { run } as unknown as EngineRunnerPort, calls };
}

function mockGit(opts: { hasChanges?: boolean; didCommit?: boolean; sha?: string } = {}): {
  git: LocalGitService;
  commitAll: ReturnType<typeof vi.fn>;
  headSha: ReturnType<typeof vi.fn>;
} {
  const base = 'base-sha';
  const committed = opts.sha ?? 'fix-sha';
  const didCommit = opts.didCommit ?? true;
  let call = 0;
  const headSha = vi.fn(async () => (++call === 1 ? base : didCommit ? committed : base));
  const commitAll = vi.fn(async () => 'HOST-COMMIT-MUST-NOT-HAPPEN');
  const git = {
    hasChanges: vi.fn(async () => opts.hasChanges ?? false),
    headSha,
    commitAll,
  } as unknown as LocalGitService;
  return { git, commitAll, headSha };
}

describe('AutoFixStage — fan-out + aggregate + fix + commit', () => {
  it('fans out one review pass PER lens (N passes) and aggregates findings', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', file: 'src/x.ts', title: 'finding A' }]),
        l2: reportWith([{ severity: 'medium', file: 'src/y.ts', title: 'finding B' }]),
      },
    });
    const { git } = mockGit({ sha: 'sha-1' });
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
    const { git } = mockGit({ sha: 'sha-1' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].severity).toBe('high'); // highest wins
    expect(summary.findings[0].lens.split('+').sort()).toEqual(['l1', 'l2']);
  });

  it('applies fixes via an execute turn — the fix AGENT commits, the host reads HEAD (no host commit)', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([
          {
            severity: 'high',
            file: 'src/x.ts',
            title: 'finding A',
            detail: 'fix it',
          },
        ]),
        l2: reportWith([]),
      },
      fixReport: 'I fixed finding A.',
    });
    const { git, commitAll } = mockGit({ sha: 'commitsha1' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(calls.some((c) => c.mode === 'execute')).toBe(true);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.fixesAttempted).toBe(true);
    expect(summary.fixReport).toBe('I fixed finding A.');
    expect(summary.commits).toEqual([
      {
        sha: 'commitsha1',
        message: expect.stringContaining('thread review fixes'),
      },
    ]);
  });

  it('threads Autofix effort only onto matching Claude child turns, preserving Codex defaults', async () => {
    const finding = {
      lens: 'l1',
      severity: 'high' as const,
      file: 'src/x.ts',
      title: 'finding A',
      detail: 'fix it',
    };

    const claude = mockEngine({
      reviewReports: { l1: reportWith([finding]) },
      fixReport: 'fixed finding A.',
    });
    const claudeStage = new AutoFixStage(
      claude.engine,
      mockGit({ sha: 'claude-sha' }).git,
      mockHarness().factory,
    );

    await claudeStage.runReviewLens(ctx, LENSES[0]);
    expect(claude.calls[0]).toMatchObject({
      mode: 'review',
      engine: 'claude',
      modelReasoningEffort: 'high',
    });

    await claudeStage.applyReviewFindings(ctx, [finding]);
    expect(claude.calls[1]).toMatchObject({
      mode: 'execute',
      engine: 'claude',
      modelReasoningEffort: 'high',
    });

    const codex = mockEngine({
      reviewReports: { l1: reportWith([finding]) },
      fixReport: 'fixed finding A.',
    });
    const codexStage = new AutoFixStage(
      codex.engine,
      mockGit({ sha: 'codex-sha' }).git,
      mockHarness().factory,
    );

    await codexStage.runReviewLens(ctx, LENSES[0], { engine: 'codex' });
    expect(codex.calls[0]).toMatchObject({ mode: 'review', engine: 'codex' });
    expect(codex.calls[0].modelReasoningEffort).toBeUndefined();

    await codexStage.applyReviewFindings(ctx, [finding], { engine: 'codex' });
    expect(codex.calls[1]).toMatchObject({ mode: 'execute', engine: 'codex' });
    expect(codex.calls[1].modelReasoningEffort).toBeUndefined();
  });

  it('PR-tail mode tags the commit message + summary mode (from the agent-authored HEAD)', async () => {
    const { engine } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]),
        l2: reportWith([]),
      },
    });
    const { git, commitAll } = mockGit({ sha: 'prsha' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixPullRequest(ctx, { lenses: LENSES });

    expect(summary.mode).toBe('pull_request');
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.commits).toEqual([
      {
        sha: 'prsha',
        message: expect.stringContaining('PR-tail review fixes'),
      },
    ]);
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

    const summary = await stage.autofixThread(ctx, {
      lenses: LENSES,
      fixMinSeverity: 'medium',
    });

    expect(calls.some((c) => c.mode === 'execute')).toBe(false);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.fixesAttempted).toBe(false);
    expect(summary.findings).toHaveLength(1); // still reported
  });

  it('report-only (applyFixes:false) reviews but never writes/commits', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]),
        l2: reportWith([]),
      },
    });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, {
      lenses: LENSES,
      applyFixes: false,
    });

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
    const { engine, calls } = mockEngine({ reviewReports: {} });
    const { git, commitAll } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(
      { ...ctx, worktreePath: '/tmp', changedFiles: [] },
      { lenses: LENSES },
    );

    expect(calls).toEqual([]); // NO engine turns at all (no review, no fix)
    expect(summary.lensesRun).toEqual([]);
    expect(summary.findings).toEqual([]);
    expect(summary.clean).toBe(true);
    expect(commitAll).not.toHaveBeenCalled();
  });

  it('produces no commit when the fix agent changes nothing (HEAD unchanged from base)', async () => {
    const { engine } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]),
        l2: reportWith([]),
      },
    });
    const { git, commitAll } = mockGit({ didCommit: false });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.fixesAttempted).toBe(true); // the fix turn ran
    expect(commitAll).not.toHaveBeenCalled(); // host never commits
    expect(summary.commits).toEqual([]); // HEAD == base → no fix commit reported
  });

  it('reports no commit when the fix agent LEFT a dirty tree (forgot to commit its own work)', async () => {
    const { engine } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', title: 'x', file: 'a.ts' }]),
        l2: reportWith([]),
      },
    });
    const { git, commitAll } = mockGit({ hasChanges: true });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.fixesAttempted).toBe(true);
    expect(commitAll).not.toHaveBeenCalled();
    expect(summary.commits).toEqual([]);
  });

  it('a single failed review pass is dropped, not fatal (other lenses still aggregate)', async () => {
    const calls: Array<{ mode: string; sandboxKey: EngineHomeKey }> = [];
    const run = vi.fn(async (args: { mode: string; sandboxKey: EngineHomeKey }) => {
      calls.push({ mode: args.mode, sandboxKey: args.sandboxKey });
      if (args.mode === 'execute') return { result: 'fixed' };
      const lensId = reviewLensId(args.sandboxKey);
      if (lensId === 'l1') throw new Error('engine boom');
      return {
        result: reportWith([{ severity: 'high', file: 'a.ts', title: 'survivor' }]),
      };
    });
    const engine = { run } as unknown as EngineRunnerPort;
    const { git } = mockGit({ sha: 's' });
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const summary = await stage.autofixThread(ctx, { lenses: LENSES });

    expect(summary.findings.map((f) => f.title)).toEqual(['survivor']);
  });

  it('respects the configured concurrency cap (batched fan-out)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run = vi.fn(async (args: { mode: string; sandboxKey: EngineHomeKey }) => {
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
    const { git } = mockGit({ sha: 'sha-1' });
    const h = mockHarness();
    const stage = new AutoFixStage(engine, git, h.factory);

    await stage.autofixThread(streamCtx, { lenses: LENSES });

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
    expect(calls.every((c) => c.richStream === true && c.hasOnEvent)).toBe(true);
    expect(h.finish).toHaveBeenCalledTimes(3);
  });

  it('does NOT create a harness (nor richStream) when the ctx carries no streaming identity', async () => {
    const { engine, calls } = mockEngine({
      reviewReports: {
        l1: reportWith([{ severity: 'high', file: 'a.ts', title: 'A' }]),
        l2: reportWith([]),
      },
    });
    const { git } = mockGit({ sha: 's' });
    const h = mockHarness();
    const stage = new AutoFixStage(engine, git, h.factory);

    await stage.autofixThread(ctx, { lenses: LENSES }); // ctx has no jobId/channel

    expect(h.create).not.toHaveBeenCalled();
    expect(calls.every((c) => !c.richStream)).toBe(true);
  });

  it('aborts (not finishes) the lens harness when a review pass throws', async () => {
    const run = vi.fn(
      async (args: {
        mode: string;
        sandboxKey: EngineHomeKey;
        richStream?: boolean;
        onEvent?: unknown;
      }) => {
        if (args.mode === 'review' && args.sandboxKey.subId === 'review-l1') {
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

    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenCalledTimes(1);
  });
});

describe('AutoFixStage — framework lens injects skill bodies into the runtime engine turn', () => {
  const injectedRule = 'Never use array index as a list key.';
  const frameworkLens = lensById('framework')!;

  const frameworkCtx: AutoFixContext = {
    ...ctx,
    frameworkBodies: [{ name: 'react-review-checklist', body: `# Rules\n\n- ${injectedRule}` }],
  };

  it('hands the injected skill body to engine.run and parses the returned finding', async () => {
    let capturedTask: string | undefined;
    let capturedMode: string | undefined;
    const run = vi.fn(async (args: { mode: string; task: string; sandboxKey: EngineHomeKey }) => {
      capturedTask = args.task;
      capturedMode = args.mode;
      return {
        result: reportWith([
          {
            severity: 'high',
            file: 'src/List.tsx',
            title: 'array index used as key',
          },
        ]),
        sessionId: 'rev-framework',
      };
    });
    const engine = { run } as unknown as EngineRunnerPort;
    const { git } = mockGit({});
    const stage = new AutoFixStage(engine, git, mockHarness().factory);

    const findings = await stage.runReviewLens(frameworkCtx, frameworkLens);

    expect(capturedMode).toBe('review');
    expect(capturedTask).toContain(injectedRule);
    expect(capturedTask).toContain('react-review-checklist');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      lens: 'framework',
      severity: 'high',
      file: 'src/List.tsx',
    });
  });
});
