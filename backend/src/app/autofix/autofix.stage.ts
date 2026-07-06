import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../engine';
import type { EngineEvent, ExecutionTarget } from '../engine';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { LocalGitService } from '../git';
import { TurnHarnessFactory, type TurnHarness } from '../surface/turn-harness.service';
import { laneFor } from '../surface/thread-registry';
import { Agent, renderAgentPrompt } from '../prompt-kit';
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

// ── transcript-lane / meta contract (mirrors the `codex-review:*` convention) ──────────────────────
// The auto-fix stage streams onto the shared spine so the web can peel it exactly like Codex review / a
// build phase. The CONTRACT the web consumes (see `docs/handoffs/autofix-review-lane-ui.md`):
//   • lanes:  stage node `autofix:<autofixId>`  ·  per-lens `autofix:<autofixId>:<lensId>`  ·  fix turn
//             `autofix:<autofixId>:fix`. Per-lens sub-lanes are REQUIRED — the lenses run concurrently and
//             `LiveTurnStore` keys an in-flight turn by (channel, jobId, lane), so one shared lane would let
//             the first lens's `finish()` end the lane out from under the others.
//   • block meta (stamped by the harness `metaTag`): `{ autofixId, scope, lensId? , fixTurn? }`.
//   • the `autofix_anchor` durable row (kind + `meta.autofixAnchor`) is emitted by the CALLER (driver / ship),
//     paired with a change-signal post so the web wakes at stage start — NOT by this stage.
// These are thin re-exports of the THREAD_REGISTRY (`../surface/thread-registry`) — the wire strings are
// byte-identical; the names are kept so existing callers don't churn.
/** The stage node lane (the card / aggregate opens this). */
export const autofixLane = (autofixId: string): string => laneFor('autofix-stage', autofixId);
/** One review lens's sub-lane — live-safe for the concurrent fan-out. */
export const autofixLensLane = (autofixId: string, lensId: string): string =>
  laneFor('autofix-lens', autofixId, lensId);
/** The fix turn's sub-lane. */
export const autofixFixLane = (autofixId: string): string => laneFor('autofix-fix', autofixId);

/**
 * W7 — the AUTO-FIX STAGE. A fan-out of N parallel read-only review passes (one per lens) over a
 * thread's (or the whole feature's) diff → aggregate + dedupe the findings → ONE execute turn that
 * applies the fixes confined to the worktree AND commits + pushes them itself (the host reads HEAD; it no
 * longer commits on the agent's behalf). Two entry points share the core: `autofixThread` (after a
 * thread's steps) and `autofixPullRequest` (PR-tail, over the whole accumulated diff before handing the
 * PR to the human).
 *
 * Design properties:
 * - **Fan-out is data.** Width = the selected lens list's length (configurable via options); each lens
 *   is a vanilla EngineRunner review turn. A single failed pass is logged + dropped, never sinks the run.
 * - **Conservative by default.** Fix turn runs only for findings ≥ `fixMinSeverity` (default 'medium')
 *   and only when `applyFixes` (default true) is on. Report-only is a one-flag dry run.
 * - **Idempotent / safe to re-run.** A clean re-run finds nothing, attempts no fix, and produces no
 *   commit (the fix AGENT commits its own work; HEAD unchanged from base ⇒ nothing reported), so running
 *   twice is a no-op the second time.
 *
 * Composes W1's EngineRunner + LocalGitService, plus the @Global {@link TurnHarnessFactory} (the shared
 * transcript spine) so its review lenses + fix turn stream + persist exactly like the brain, a build phase,
 * and Codex review — used ONLY when the context carries a streaming identity (jobId + channel); absent, the
 * stage runs the engine directly with no harness (byte-identical to its pre-streaming behavior). Zero v1
 * `slack-app` imports.
 */
@Injectable()
export class AutoFixStage {
  private readonly logger = new Logger(AutoFixStage.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly git: LocalGitService,
    // Shared transcript spine (@Global LiveTurnModule) — used ONLY when the context carries a streaming
    // identity (jobId + channel). The same factory the brain, build driver, and Codex review use.
    private readonly turnHarness: TurnHarnessFactory,
    // Durable per-model usage/cost analytics (best-effort); orgId resolved from jobId (ctx has no org).
    // @Optional so unit tests construct the stage without wiring analytics; DI (@Global) supplies it live.
    @Optional() private readonly usage?: TurnUsageProjector,
  ) {}

  /** The execution target for a turn — the sandbox container when the driver ran in docker mode. */
  private targetFor(ctx: AutoFixContext): ExecutionTarget | undefined {
    if (!ctx.containerId) return undefined;
    return {
      containerId: ctx.containerId,
      worktreeHost: ctx.worktreePath,
      ...(ctx.execUser ? { user: ctx.execUser } : {}),
      // The fix turn commits + pushes its own work — give it the authenticated remote (parity with the
      // builder/gate/master-review turns). Absent gitAuth → no push (host-local / unit-test path).
      ...(ctx.gitAuth ? { gitAuth: ctx.gitAuth } : {}),
    };
  }

  /**
   * A {@link TurnHarness} bound to one auto-fix turn's lane — or `undefined` when the context carries no
   * streaming identity (jobId + channel), in which case the caller runs the engine directly with no
   * harness (the pre-streaming path). `sub` picks the sub-lane + block meta: a review lens or the fix turn.
   */
  private harnessFor(
    ctx: AutoFixContext,
    sub: { lensId: string } | { fix: true },
  ): TurnHarness | undefined {
    if (!ctx.jobId || !ctx.channel || !ctx.autofixId) return undefined;
    const isFix = 'fix' in sub;
    const lane = isFix
      ? autofixFixLane(ctx.autofixId)
      : autofixLensLane(ctx.autofixId, sub.lensId);
    return this.turnHarness.create({
      jobId: ctx.jobId,
      channel: ctx.channel,
      lane,
      metaTag: {
        autofixId: ctx.autofixId,
        ...(ctx.scope ? { scope: ctx.scope } : {}),
        ...(isFix ? { fixTurn: true } : { lensId: sub.lensId }),
      },
    });
  }

  /**
   * Per-thread auto-fix — run after a thread's steps complete, over that thread's change set.
   * `ctx.diff`/`ctx.gitRange` should scope to the thread (e.g. the thread's start sha `..HEAD`).
   */
  async autofixThread(ctx: AutoFixContext, options: AutoFixOptions = {}): Promise<AutoFixSummary> {
    return this.run('thread', ctx, options);
  }

  /**
   * PR-tail auto-fix — run once after all threads, over the WHOLE accumulated feature diff (e.g.
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
    mode: 'thread' | 'pull_request',
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

    // Nothing changed in this scope → there is nothing to review. A thread that only investigated (or
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

  /** One read-only review pass for a lens. Failures are logged + swallowed (return []) — the internal
   *  fan-out (`autofixThread`/`autofixPullRequest`) must not let a single bad lens sink the whole run. */
  private async reviewPass(
    lens: ReviewLens,
    ctx: AutoFixContext,
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<ReviewFinding[]> {
    this.notifyLensStatus(options, lens.id, 'running');
    try {
      const found = await this.reviewLensCore(lens, ctx, engine ?? 'claude', options);
      this.logger.debug(`Lens "${lens.id}": ${found.length} finding(s)`);
      this.notifyLensStatus(options, lens.id, 'passed', found.length);
      return found;
    } catch (err) {
      this.logger.warn(`Lens "${lens.id}" review pass failed (dropped): ${err}`);
      this.notifyLensStatus(options, lens.id, 'failed');
      return [];
    }
  }

  /**
   * The CORE of one read-only review lens turn: stream on its sub-lane, run the engine, record usage, parse
   * findings. Errors PROPAGATE (after closing the lane) — the swallow lives in `reviewPass` (the fan-out) so
   * the child-thread path (`runReviewLens`) can record a real per-lens failure instead of a silent `[]`.
   */
  private async reviewLensCore(
    lens: ReviewLens,
    ctx: AutoFixContext,
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<ReviewFinding[]> {
    // Stream this lens's reasoning + file reads onto its own sub-lane (when the ctx carries a streaming
    // identity) so it renders like every other agent turn. `undefined` → the pre-streaming direct path.
    const harness = this.harnessFor(ctx, { lensId: lens.id });
    const task = buildReviewPrompt(lens, ctx);
    // Surface this lens's review prompt on its sub-lane, inline before its reasoning — so the operator sees
    // what the reviewer was asked, not just its findings. Best-effort; no-op on the direct path (no harness).
    await harness?.emitPrompt(task, `autofix:${ctx.autofixId}:${lens.id}`);
    try {
      const target = this.targetFor(ctx);
      const res = await this.engine.run({
        engine: engine ?? 'claude',
        task,
        cwd: ctx.worktreePath,
        systemPrompt: renderAgentPrompt(Agent.AUTOFIX_REVIEW),
        sandboxKey: `${ctx.sandboxKey}--review-${lens.id}`,
        mode: 'review',
        ...(harness ? { richStream: true, onEvent: (e) => harness.onEvent(e) } : {}),
        ...(target ? { target } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
      });
      await harness?.finish(res.result, res.usage ? { usage: res.usage } : undefined);
      if (ctx.jobId) {
        void this.usage?.record(
          {
            jobId: ctx.jobId,
            lane: ctx.autofixId ? `autofix:${ctx.autofixId}` : 'autofix',
            kind: 'autofix',
            engine: engine ?? 'claude',
            metaTag: { ...(ctx.autofixId ? { autofixId: ctx.autofixId } : {}), lensId: lens.id },
          },
          res.usage,
        );
      }
      return parseFindings(lens.id, res.result);
    } catch (err) {
      // Persist whatever streamed before the error + close the live lane (idempotent vs finish), then rethrow.
      await harness?.abort().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Post a short, lane-correct NOTICE on a review child's transcript lane (a `review_lens` by id, or the
   * `post_review` fix turn) so a review that is SKIPPED — an empty diff, nothing to review — reads as an
   * explicit line in its pane instead of a silent blank. Reuses the harness's end-of-turn text fallback (one
   * `chat` block stamped with the lane's `{ autofixId, lensId | fixTurn }` meta), so no engine turn runs.
   * Best-effort: a no-op when the ctx carries no streaming identity (jobId + channel + autofixId).
   */
  async emitReviewNotice(
    ctx: AutoFixContext,
    sub: { lensId: string } | { fix: true },
    message: string,
  ): Promise<void> {
    const harness = this.harnessFor(ctx, sub);
    await harness?.finish(message).catch(() => undefined);
  }

  // ── child-thread runners (the `review_lens` / `post_review` kinds drive these one row at a time) ──────
  // The driver materializes a builder's review as real child `threads` rows and drives each as its own turn
  // (lenses concurrently, then the fix). These expose the exact review/fix turns the fan-out uses, so the
  // orchestration moves into the driver's child mechanism without duplicating the engine/harness plumbing.

  /** Ensure a context carries its diff + changedFiles — the driver derives the diff ONCE and shares the
   *  enriched ctx across the per-lens turns + the fix turn (mirrors what `run()` does internally). */
  async ensureContextDiff(ctx: AutoFixContext): Promise<AutoFixContext> {
    return this.ensureDiff(ctx);
  }

  /** Run ONE review lens as its own turn (the `review_lens` child thread's runner), returning its FULL
   *  findings. Errors PROPAGATE so the driver records the failure on that lens's own row — no shared array
   *  to silently drop into (the structural fix for the lost-update "stuck at reviewing" bug). */
  async runReviewLens(
    ctx: AutoFixContext,
    lens: ReviewLens,
    options: AutoFixOptions = {},
  ): Promise<ReviewFinding[]> {
    const enriched = await this.ensureDiff(ctx);
    return this.reviewLensCore(lens, enriched, options.engine ?? 'claude', options);
  }

  /** Run the single fix turn over the deduped, severity-filtered findings (the `post_review` child thread's
   *  runner). The fix AGENT commits + pushes its own work; the host reads the resulting HEAD. */
  async applyReviewFindings(
    ctx: AutoFixContext,
    findings: ReviewFinding[],
    options: AutoFixOptions = {},
  ): Promise<{ fixReport: string; commits: AutoFixCommit[] }> {
    const enriched = await this.ensureDiff(ctx);
    return this.applyAndCommit(enriched, findings, 'thread', options.engine ?? 'claude', options);
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

  /** Run the single execute fix turn; the fix agent commits + pushes its own work, and the host READS the
   *  resulting HEAD to report the fix commit (it no longer commits on the agent's behalf). */
  private async applyAndCommit(
    ctx: AutoFixContext,
    findings: ReviewFinding[],
    mode: 'thread' | 'pull_request',
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<{ fixReport: string; commits: AutoFixCommit[] }> {
    // Stream the fix turn onto the `…:fix` sub-lane (when streaming); else the coarse debug log only.
    const harness = this.harnessFor(ctx, { fix: true });
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'tool') this.logger.debug(`fix-turn tool: ${e.name}`);
      harness?.onEvent(e);
    };
    const target = this.targetFor(ctx);
    const task = buildFixPrompt(findings, ctx);
    // The base HEAD before the fix turn — used after to tell "the agent committed a fix" (HEAD advanced)
    // from "nothing to fix / no commit" (HEAD unchanged), now that the AGENT (not the host) commits.
    const baseSha = await this.git.headSha(ctx.worktreePath).catch(() => null);
    // Surface the fix turn's prompt on its `…:fix` sub-lane, inline before the fix work. Keyed per autofix
    // stage; no-op on the pre-streaming direct path. Best-effort.
    await harness?.emitPrompt(task, `autofix:${ctx.autofixId}:fix`);
    let res;
    try {
      res = await this.engine.run({
        engine: engine ?? 'claude',
        task,
        cwd: ctx.worktreePath,
        systemPrompt: renderAgentPrompt(Agent.AUTOFIX_FIX),
        sandboxKey: `${ctx.sandboxKey}--fix`,
        mode: 'execute',
        ...(harness ? { richStream: true } : {}),
        onEvent,
        ...(target ? { target } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
      });
    } catch (err) {
      await harness?.abort().catch(() => undefined);
      throw err;
    }
    await harness?.finish(res.result, res.usage ? { usage: res.usage } : undefined);
    if (ctx.jobId) {
      void this.usage?.record(
        {
          jobId: ctx.jobId,
          lane: ctx.autofixId ? `autofix:${ctx.autofixId}` : 'autofix',
          kind: 'autofix',
          engine: engine ?? 'claude',
          metaTag: { ...(ctx.autofixId ? { autofixId: ctx.autofixId } : {}), fixTurn: true },
        },
        res.usage,
      );
    }

    const fixReport = res.result;

    // The FIX AGENT commits + pushes its own work now (its prompt requires a clean tree). The host no longer
    // commits — it only READS what the agent produced. A still-dirty tree means the model forgot; log it and
    // leave the tree for the next pass rather than committing on its behalf (autofix is best-effort and never
    // halts the build). Report the HEAD sha as the fix commit when one landed (HEAD advanced past its base).
    if (await this.git.hasChanges(ctx.worktreePath)) {
      this.logger.warn(
        `Auto-fix (${mode}): fix turn left an uncommitted tree — the agent did not commit its own work`,
      );
      return { fixReport, commits: [] };
    }
    const head = await this.git.headSha(ctx.worktreePath).catch(() => null);
    if (!head || head === baseSha) {
      this.logger.log(`Auto-fix (${mode}): fix turn produced no new commit — nothing to apply`);
      return { fixReport, commits: [] };
    }
    const label = ctx.label ? `: ${ctx.label}` : '';
    const message =
      mode === 'pull_request'
        ? `chore(autofix): PR-tail review fixes${label}`
        : `chore(autofix): thread review fixes${label}`;
    this.logger.log(`Auto-fix (${mode}): fix agent committed ${head.slice(0, 8)}`);
    return { fixReport, commits: [{ sha: head, message }] };
  }

  /**
   * Ensure `ctx.diff` is populated. The driver normally supplies it (it already holds the thread's
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
