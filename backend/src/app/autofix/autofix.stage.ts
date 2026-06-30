import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineEvent, ExecutionTarget } from '../engine';
import { LocalGitService } from '../git';
import {
  buildFixPrompt,
  buildReviewPrompt,
  DEFAULT_LENSES,
  dedupeFindings,
  meetsSeverity,
  parseFindings,
} from './autofix-lenses';
import type {
  AutoFixCommit,
  AutoFixContext,
  AutoFixOptions,
  AutoFixSummary,
  FindingSeverity,
  LensStatus,
  ReviewFinding,
  ReviewLens,
} from './autofix.types';

/** Conservative defaults — the driver can call the stage with no opts and get safe behavior. */
const DEFAULT_FIX_MIN_SEVERITY: FindingSeverity = 'medium';
const DEFAULT_CONCURRENCY = 3;

const REVIEW_SYSTEM_PROMPT =
  'You are a precise, terse senior code reviewer embedded in an automated pipeline. You report only ' +
  'real, in-scope issues and always answer in the exact JSON contract you are given.';
const FIX_SYSTEM_PROMPT =
  'You are a senior engineer applying a curated, minimal set of review fixes. You make the smallest ' +
  'safe change per finding, never expand scope, and skip anything unsafe rather than guessing.';

/**
 * W7 — the AUTO-FIX STAGE. A fan-out of N parallel read-only review passes (one per lens) over a
 * track's (or the whole feature's) diff → aggregate + dedupe the findings → ONE execute turn that
 * applies the fixes confined to the worktree → a `LocalGitService` commit. Two entry points share the
 * core: `autofixTrack` (after a track's steps) and `autofixPullRequest` (PR-tail, over the whole
 * accumulated diff before handing the PR to the human).
 *
 * Design properties:
 * - **Fan-out is data.** Width = the selected lens list's length (configurable via options); each lens
 *   is a vanilla EngineRunner review turn. A single failed pass is logged + dropped, never sinks the run.
 * - **Conservative by default.** Fix turn runs only for findings ≥ `fixMinSeverity` (default 'medium')
 *   and only when `applyFixes` (default true) is on. Report-only is a one-flag dry run.
 * - **Idempotent / safe to re-run.** A clean re-run finds nothing, attempts no fix, and produces no
 *   commit (`commitAll` returns null when the tree is clean), so running twice is a no-op the second time.
 *
 * Zero imports from `harness/**` or the v1 `slack-app` surface — it composes ONLY W1's EngineRunner +
 * LocalGitService.
 */
@Injectable()
export class AutoFixStage {
  private readonly logger = new Logger(AutoFixStage.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly git: LocalGitService,
  ) {}

  /** The execution target for a turn — the sandbox container when the driver ran in docker mode. */
  private targetFor(ctx: AutoFixContext): ExecutionTarget | undefined {
    if (!ctx.containerId) return undefined;
    return {
      containerId: ctx.containerId,
      worktreeHost: ctx.worktreePath,
      ...(ctx.execUser ? { user: ctx.execUser } : {}),
    };
  }

  /**
   * Per-track auto-fix — run after a track's steps complete, over that track's change set.
   * `ctx.diff`/`ctx.gitRange` should scope to the track (e.g. the track's start sha `..HEAD`).
   */
  async autofixTrack(ctx: AutoFixContext, options: AutoFixOptions = {}): Promise<AutoFixSummary> {
    return this.run('track', ctx, options);
  }

  /**
   * PR-tail auto-fix — run once after all tracks, over the WHOLE accumulated feature diff (e.g.
   * `ctx.gitRange = 'origin/<base>...HEAD'`), before the PR is handed to the human reviewer.
   */
  async autofixPullRequest(
    ctx: AutoFixContext,
    options: AutoFixOptions = {},
  ): Promise<AutoFixSummary> {
    return this.run('pull_request', ctx, options);
  }

  // ── core ─────────────────────────────────────────────────────────────────────────────────────

  private async run(
    mode: 'track' | 'pull_request',
    rawCtx: AutoFixContext,
    options: AutoFixOptions,
  ): Promise<AutoFixSummary> {
    const lenses = options.lenses?.length ? options.lenses : DEFAULT_LENSES;
    const applyFixes = options.applyFixes ?? true;
    const fixMinSeverity = options.fixMinSeverity ?? DEFAULT_FIX_MIN_SEVERITY;
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const engine = options.engine ?? 'claude';

    // Make sure the context carries a diff: derive one from the worktree if the driver didn't supply it.
    const ctx = await this.ensureDiff(rawCtx);
    const label = ctx.label ?? mode;

    // Nothing changed in this scope → there is nothing to review. A track that only investigated (or
    // otherwise committed nothing) would otherwise burn N review turns on an empty diff and find nothing.
    // Deterministic short-circuit: skip the lens fan-out + fix turn and return a clean summary.
    if (!ctx.changedFiles?.length) {
      this.logger.log(`Auto-fix (${mode}) "${label}": 0 changed files — skipping review`);
      // The lenses never run, but a status hook may have seeded them `pending` — resolve them so the
      // navigator's review folder doesn't show agents stuck pending forever.
      for (const lens of lenses) this.notifyLensStatus(options, lens.id, 'skipped');
      return {
        mode,
        lensesRun: [],
        findings: [],
        fixesAttempted: false,
        fixReport: '',
        commits: [],
        clean: true,
      };
    }

    this.logger.log(
      `Auto-fix (${mode}) "${label}": fanning out ${lenses.length} lens(es) over ${ctx.changedFiles.length} changed file(s) in ${ctx.worktreePath}`,
    );

    // 1) Fan out the review passes in parallel (capped), each a read-only review turn.
    const findings = await this.fanOutReview(lenses, ctx, concurrency, engine, options);

    // 2) Aggregate + dedupe across lenses.
    const deduped = dedupeFindings(findings);
    const actionable = deduped.filter((f) => meetsSeverity(f.severity, fixMinSeverity));

    this.logger.log(
      `Auto-fix (${mode}) "${label}": ${deduped.length} unique finding(s), ${actionable.length} ≥ ${fixMinSeverity}`,
    );

    const base: AutoFixSummary = {
      mode,
      lensesRun: lenses.map((l) => l.id),
      findings: deduped,
      fixesAttempted: false,
      fixReport: '',
      commits: [],
      clean: deduped.length === 0,
    };

    // 3) Apply fixes — only when enabled AND there's something at/above the threshold.
    if (!applyFixes || actionable.length === 0) {
      return base;
    }

    const { fixReport, commits } = await this.applyAndCommit(ctx, actionable, mode, engine, options);
    return {
      ...base,
      fixesAttempted: true,
      fixReport,
      commits,
    };
  }

  /** Fan out one read-only review turn per lens, capped at `concurrency`, collecting all findings. */
  private async fanOutReview(
    lenses: ReviewLens[],
    ctx: AutoFixContext,
    concurrency: number,
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<ReviewFinding[]> {
    const all: ReviewFinding[] = [];
    for (let i = 0; i < lenses.length; i += concurrency) {
      const batch = lenses.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((lens) => this.reviewPass(lens, ctx, engine, options)),
      );
      for (const r of results) all.push(...r);
    }
    return all;
  }

  /** One read-only review pass for a lens. Failures are logged + swallowed (return []). */
  private async reviewPass(
    lens: ReviewLens,
    ctx: AutoFixContext,
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<ReviewFinding[]> {
    this.notifyLensStatus(options, lens.id, 'running');
    try {
      const target = this.targetFor(ctx);
      const res = await this.engine.run({
        engine: engine ?? 'claude',
        task: buildReviewPrompt(lens, ctx),
        cwd: ctx.worktreePath,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        sandboxKey: `${ctx.sandboxKey}--review-${lens.id}`,
        mode: 'review',
        ...(target ? { target } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
      });
      const found = parseFindings(lens.id, res.result);
      this.logger.debug(`Lens "${lens.id}": ${found.length} finding(s)`);
      this.notifyLensStatus(options, lens.id, 'passed', found.length);
      return found;
    } catch (err) {
      this.logger.warn(`Lens "${lens.id}" review pass failed (dropped): ${err}`);
      this.notifyLensStatus(options, lens.id, 'failed');
      return [];
    }
  }

  /** Fire the optional per-lens status hook, swallowing any error (display-only, never sinks a pass). */
  private notifyLensStatus(
    options: AutoFixOptions,
    lensId: string,
    status: LensStatus,
    findings?: number,
  ): void {
    if (!options.onLensStatus) return;
    try {
      options.onLensStatus(lensId, status, findings);
    } catch (err) {
      this.logger.warn(`onLensStatus hook threw (ignored) for "${lensId}": ${err}`);
    }
  }

  /** Run the single execute fix turn, then commit whatever it changed. */
  private async applyAndCommit(
    ctx: AutoFixContext,
    findings: ReviewFinding[],
    mode: 'track' | 'pull_request',
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<{ fixReport: string; commits: AutoFixCommit[] }> {
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'tool') this.logger.debug(`fix-turn tool: ${e.name}`);
    };
    const target = this.targetFor(ctx);
    const res = await this.engine.run({
      engine: engine ?? 'claude',
      task: buildFixPrompt(findings, ctx),
      cwd: ctx.worktreePath,
      systemPrompt: FIX_SYSTEM_PROMPT,
      sandboxKey: `${ctx.sandboxKey}--fix`,
      mode: 'execute',
      onEvent,
      ...(target ? { target } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.auth ? { auth: options.auth } : {}),
    });

    const fixReport = res.result;

    // Commit only if the fix turn actually changed the tree — keeps re-runs a no-op + the PR clean.
    if (!(await this.git.hasChanges(ctx.worktreePath))) {
      this.logger.log(`Auto-fix (${mode}): fix turn produced no file changes — nothing to commit`);
      return { fixReport, commits: [] };
    }
    const label = ctx.label ? `: ${ctx.label}` : '';
    const message =
      mode === 'pull_request'
        ? `chore(autofix): PR-tail review fixes${label}`
        : `chore(autofix): track review fixes${label}`;
    const sha = await this.git.commitAll(ctx.worktreePath, message);
    if (!sha) {
      return { fixReport, commits: [] };
    }
    this.logger.log(`Auto-fix (${mode}): committed fixes ${sha.slice(0, 8)}`);
    return { fixReport, commits: [{ sha, message }] };
  }

  /**
   * Ensure `ctx.diff` is populated. The driver normally supplies it (it already holds the track's
   * diff); when absent we derive one from the worktree git state via `ctx.gitRange` (else `HEAD`),
   * and backfill `changedFiles` from `--name-only`. Best-effort — a failed derivation leaves the diff
   * empty and the review prompt instructs the engine to inspect the tree itself.
   */
  private async ensureDiff(ctx: AutoFixContext): Promise<AutoFixContext> {
    if (ctx.diff && ctx.changedFiles?.length) return ctx;
    const range = ctx.gitRange;
    const diff = ctx.diff ?? (await this.gitDiff(ctx.worktreePath, range));
    const changedFiles =
      ctx.changedFiles?.length
        ? ctx.changedFiles
        : await this.gitNameOnly(ctx.worktreePath, range);
    return { ...ctx, diff, changedFiles };
  }

  /** `git diff [range]` in the worktree — best-effort (returns '' on failure). */
  private async gitDiff(worktreePath: string, range?: string): Promise<string> {
    try {
      const args = range ? ['diff', range] : ['diff', 'HEAD'];
      return await this.rawGit(worktreePath, args);
    } catch (err) {
      this.logger.warn(`Could not derive diff (${range ?? 'HEAD'}): ${err}`);
      return '';
    }
  }

  /** `git diff --name-only [range]` in the worktree — best-effort (returns [] on failure). */
  private async gitNameOnly(worktreePath: string, range?: string): Promise<string[]> {
    try {
      const args = range ? ['diff', '--name-only', range] : ['diff', '--name-only', 'HEAD'];
      const out = await this.rawGit(worktreePath, args);
      return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Run a read-only git command in the worktree. We go through LocalGitService for mutating ops
   * (commit), but diff/name-only are read-only and not on its surface, so we exec directly here.
   */
  private async rawGit(cwd: string, args: string[]): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  }
}
