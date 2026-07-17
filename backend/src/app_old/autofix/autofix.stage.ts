import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { EngineEvent, ExecutionTarget, RunEngineArgs } from '../../_shared/engine';
import { ENGINE_RUNNER, type EngineRunnerPort } from '../../_shared/engine';
import { Agent, renderAgentPrompt } from '../../_shared/prompt-kit/system';
import { TurnUsageProjector } from '../analytics/turn-usage-projector.service';
import { ConventionProfileResolver } from '../conventions/convention-profile.resolver';
import { LocalGitService } from '../git/local-git.service';
import { buildFixPrompt, buildReviewPrompt } from '../prompt-kit/messages/autofix-lenses';
import { CONTAINER_CONTEXT } from '../sandbox/container-paths';
import { laneFor } from '../surface/thread-registry';
import { TurnHarnessFactory, type TurnHarness } from '../surface/turn-harness.service';
import { threadKindSpec } from '../thread-kind/registry';
import { DEFAULT_LENSES, dedupeFindings, meetsSeverity, parseFindings } from './autofix-lenses';
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

const DEFAULT_FIX_MIN_SEVERITY: FindingSeverity = 'medium';
const DEFAULT_CONCURRENCY = 3;

export const autofixLane = (autofixId: string): string => laneFor('autofix-stage', autofixId);
export const autofixLensLane = (autofixId: string, lensId: string): string =>
  laneFor('autofix-lens', autofixId, lensId);
export const autofixFixLane = (autofixId: string): string => laneFor('autofix-fix', autofixId);

@Injectable()
export class AutoFixStage {
  private readonly logger = new Logger(AutoFixStage.name);

  constructor(
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
    private readonly git: LocalGitService,
    private readonly turnHarness: TurnHarnessFactory,
    @Optional() private readonly usage?: TurnUsageProjector,
    @Optional() private readonly conventions?: ConventionProfileResolver,
  ) {}

  private async promptCtx(ctx: AutoFixContext): Promise<{
    settings?: { repoConventions: { name: string; body: string } };
  }> {
    if (!this.conventions || !ctx.orgId || !ctx.repoId) return {};
    const repoConventions = await this.conventions
      .resolveForRepo(ctx.orgId, ctx.repoId)
      .catch(() => null);
    return repoConventions ? { settings: { repoConventions } } : {};
  }

  private targetFor(ctx: AutoFixContext): ExecutionTarget | undefined {
    if (!ctx.containerId) return undefined;
    return {
      containerId: ctx.containerId,
      worktreeHost: ctx.worktreePath,
      ...(ctx.execUser ? { user: ctx.execUser } : {}),
      ...(ctx.gitAuth ? { gitAuth: ctx.gitAuth } : {}),
      evidenceDir: `${CONTAINER_CONTEXT}/evidence`,
    };
  }

  private reasoningEffortFor(
    kind: 'review_agent' | 'review_fix',
    engine: AutoFixOptions['engine'],
  ): Pick<RunEngineArgs, 'modelReasoningEffort'> {
    const spec = threadKindSpec(kind);
    const actualEngine = engine ?? 'claude';
    return spec.engine === actualEngine && spec.reasoningEffort
      ? { modelReasoningEffort: spec.reasoningEffort }
      : {};
  }

  private harnessFor(
    ctx: AutoFixContext,
    sub: { lensId: string } | { fix: true },
  ):
    | {
        harness: TurnHarness;
        route: { channel: string; jobId: string; lane: string };
      }
    | undefined {
    if (!ctx.jobId || !ctx.channel || !ctx.autofixId) return undefined;
    const isFix = 'fix' in sub;
    const lane = isFix ? autofixFixLane(ctx.autofixId) : autofixLensLane(ctx.autofixId, sub.lensId);
    const harness = this.turnHarness.create({
      jobId: ctx.jobId,
      orgId: ctx.orgId,
      threadId: ctx.threadId ?? ctx.autofixId,
      channel: ctx.channel,
      lane,
      metaTag: {
        autofixId: ctx.autofixId,
        ...(ctx.scope ? { scope: ctx.scope } : {}),
        ...(isFix ? { fixTurn: true } : { lensId: sub.lensId }),
      },
    });
    return { harness, route: { channel: ctx.channel, jobId: ctx.jobId, lane } };
  }

  async autofixThread(ctx: AutoFixContext, options: AutoFixOptions = {}): Promise<AutoFixSummary> {
    return this.run('thread', ctx, options);
  }

  async autofixPullRequest(
    ctx: AutoFixContext,
    options: AutoFixOptions = {},
  ): Promise<AutoFixSummary> {
    return this.run('pull_request', ctx, options);
  }

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

    const ctx = await this.ensureDiff(rawCtx);
    const label = ctx.label ?? mode;

    if (!ctx.changedFiles?.length) {
      this.logger.log(`Auto-fix (${mode}) "${label}": 0 changed files — skipping review`);
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

    const findings = await this.fanOutReview(lenses, ctx, concurrency, engine, options);

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

    if (!applyFixes || actionable.length === 0) {
      return base;
    }

    const { fixReport, commits } = await this.applyAndCommit(
      ctx,
      actionable,
      mode,
      engine,
      options,
    );
    return {
      ...base,
      fixesAttempted: true,
      fixReport,
      commits,
    };
  }

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

  private async reviewLensCore(
    lens: ReviewLens,
    ctx: AutoFixContext,
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<ReviewFinding[]> {
    const streaming = this.harnessFor(ctx, { lensId: lens.id });
    const harness = streaming?.harness;
    const task = buildReviewPrompt(lens, ctx);
    await harness?.emitPrompt(task, `autofix:${ctx.autofixId}:${lens.id}`);
    try {
      const target = this.targetFor(ctx);
      const res = await this.engine.run({
        engine: engine ?? 'claude',
        task,
        cwd: ctx.worktreePath,
        systemPrompt: renderAgentPrompt(Agent.AUTOFIX_REVIEW, await this.promptCtx(ctx)),
        sandboxKey: { ...ctx.sandboxKey, subId: `review-${lens.id}` },
        mode: 'review',
        ...(harness ? { richStream: true, onEvent: (e) => harness.onEvent(e) } : {}),
        ...(streaming ? { liveRoute: streaming.route } : {}),
        ...(target ? { target } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
        ...this.reasoningEffortFor('review_agent', engine),
      });
      await harness?.finish(
        res.result,
        res.usage ? { usage: res.usage, credentialId: res.credentialId ?? null } : undefined,
      );
      if (ctx.jobId) {
        void this.usage?.record(
          {
            jobId: ctx.jobId,
            lane: ctx.autofixId ? `autofix:${ctx.autofixId}` : 'autofix',
            kind: 'autofix',
            engine: engine ?? 'claude',
            credentialId: res.credentialId ?? null,
            metaTag: {
              ...(ctx.autofixId ? { autofixId: ctx.autofixId } : {}),
              lensId: lens.id,
            },
          },
          res.usage,
        );
      }
      return parseFindings(lens.id, res.result);
    } catch (err) {
      await harness?.abort().catch(() => undefined);
      throw err;
    }
  }

  async emitReviewNotice(
    ctx: AutoFixContext,
    sub: { lensId: string } | { fix: true },
    message: string,
  ): Promise<void> {
    const harness = this.harnessFor(ctx, sub)?.harness;
    await harness?.finish(message).catch(() => undefined);
  }

  async ensureContextDiff(ctx: AutoFixContext): Promise<AutoFixContext> {
    return this.ensureDiff(ctx);
  }

  async runReviewLens(
    ctx: AutoFixContext,
    lens: ReviewLens,
    options: AutoFixOptions = {},
  ): Promise<ReviewFinding[]> {
    const enriched = await this.ensureDiff(ctx);
    return this.reviewLensCore(lens, enriched, options.engine ?? 'claude', options);
  }

  async applyReviewFindings(
    ctx: AutoFixContext,
    findings: ReviewFinding[],
    options: AutoFixOptions = {},
  ): Promise<{ fixReport: string; commits: AutoFixCommit[] }> {
    const enriched = await this.ensureDiff(ctx);
    return this.applyAndCommit(enriched, findings, 'thread', options.engine ?? 'claude', options);
  }

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

  private async applyAndCommit(
    ctx: AutoFixContext,
    findings: ReviewFinding[],
    mode: 'thread' | 'pull_request',
    engine: AutoFixOptions['engine'],
    options: AutoFixOptions,
  ): Promise<{ fixReport: string; commits: AutoFixCommit[] }> {
    const streaming = this.harnessFor(ctx, { fix: true });
    const harness = streaming?.harness;
    const onEvent = (e: EngineEvent): void => {
      if (e.kind === 'tool') this.logger.debug(`fix-turn tool: ${e.name}`);
      harness?.onEvent(e);
    };
    const target = this.targetFor(ctx);
    const task = buildFixPrompt(findings, ctx);
    const baseSha = await this.git.headSha(ctx.worktreePath).catch(() => null);
    await harness?.emitPrompt(task, `autofix:${ctx.autofixId}:fix`);
    let res;
    try {
      res = await this.engine.run({
        engine: engine ?? 'claude',
        task,
        cwd: ctx.worktreePath,
        systemPrompt: renderAgentPrompt(Agent.AUTOFIX_FIX, await this.promptCtx(ctx)),
        sandboxKey: { ...ctx.sandboxKey, subId: 'fix' },
        mode: 'execute',
        ...(harness ? { richStream: true } : {}),
        ...(streaming ? { liveRoute: streaming.route } : {}),
        onEvent,
        ...(target ? { target } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
        ...this.reasoningEffortFor('review_fix', engine),
      });
    } catch (err) {
      await harness?.abort().catch(() => undefined);
      throw err;
    }
    await harness?.finish(
      res.result,
      res.usage ? { usage: res.usage, credentialId: res.credentialId ?? null } : undefined,
    );
    if (ctx.jobId) {
      void this.usage?.record(
        {
          jobId: ctx.jobId,
          lane: ctx.autofixId ? `autofix:${ctx.autofixId}` : 'autofix',
          kind: 'autofix',
          engine: engine ?? 'claude',
          credentialId: res.credentialId ?? null,
          metaTag: {
            ...(ctx.autofixId ? { autofixId: ctx.autofixId } : {}),
            fixTurn: true,
          },
        },
        res.usage,
      );
    }

    const fixReport = res.result;

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

  private async ensureDiff(ctx: AutoFixContext): Promise<AutoFixContext> {
    if (ctx.changedFiles?.length) return ctx;
    const changedFiles = await this.gitNameOnly(ctx.worktreePath, ctx.gitRange);
    return { ...ctx, changedFiles };
  }

  private async gitNameOnly(worktreePath: string, range?: string): Promise<string[]> {
    try {
      const args = range ? ['diff', '--name-only', range] : ['diff', '--name-only', 'HEAD'];
      const out = await this.rawGit(worktreePath, args);
      return out
        ? out
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

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
