import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DecisionRecord, Job } from '../domain';
import { ENGINE_RUNNER, type EngineRunnerPort, type ExecutionTarget, type ToolImpl } from '../engine';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import { BLOCK_SINK, type BlockSink, TurnHarnessFactory } from '../surface/turn-harness.service';
import { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

/** The PR Review orchestrator's transcript lane — stable per job, so the web can subscribe by job identity
 *  the same way a build thread rides `thread:<threadId>` (see `atlas-build-thread-stable-lane-reattach`). */
const prReviewLane = (jobId: string): string => `pr-review:${jobId}`;

/**
 * Environment framing shared by every driver-side engine prompt (this file + the thread-driver's plan/
 * execute/orchestrate prompts — exported from here because build-ship is the leaf both import, like
 * {@link LEDGER_COMMIT_MESSAGE}). These sessions stream to the operator's web console, so they must never
 * hand the operator "run this locally" homework — there is no operator-side machine.
 */
export const CLOUD_SANDBOX_NOTE =
  "You run in a CLOUD SANDBOX — your own container with the checkout at /workspace — not on the operator's " +
  'machine. The operator follows along through a web console and shares NO filesystem, shell, or running ' +
  'services with you; "local" means YOUR sandbox and nothing else. Never suggest the operator run commands, ' +
  'start servers, or verify anything "on their machine" — whatever the work needs, YOU run here; your work ' +
  'reaches them only through the commits/PR and what you report.';

/**
 * Task-list discipline shared by every Atlas session that rides a task-tracked lane (the job brain on
 * `main`, a build thread's orchestrator on `thread:<id>`, PR Review on `pr-review:<jobId>` — see
 * `turn-harness.service.ts` `taskScopeFor`). The native task tools fold into the owning entity's tasks
 * column and render live in the operator's navigator, so the list IS the operator's progress view.
 * Persona prompts splice this in and add their own seeding rule (what the first tasks come from).
 */
export const TASK_LIST_NOTE =
  "LIVE TASK LIST — your native task tools (`TaskCreate`/`TaskUpdate`) render DIRECTLY in the operator's " +
  'UI as this session\'s checklist; they are how the operator follows your work at a glance. Whenever the ' +
  'work in front of you has more than one meaningful step, lay the list out FIRST: `TaskCreate` one task ' +
  'per unit of work (short, outcome-phrased subjects the operator understands), then work it — `TaskUpdate` ' +
  'a task to `in_progress` when you start it (one at a time) and `completed` the moment it finishes, never ' +
  'in a batch at the end. Keep the list TRUTHFUL as the work reshapes: add tasks you discover mid-flight, ' +
  "and drop ones that become moot (`TaskUpdate` with `status:'deleted'`). A stale checklist is worse than none.";

const PR_REVIEW_SYSTEM_PROMPT = [
  "You are Atlas's PR Review orchestrator. You run ONCE per feature, after every build thread has",
  'finished, right before the pull request opens. Maintain a live task list via TaskCreate/TaskUpdate as',
  'you work through exactly these three tasks, IN ORDER, one `in_progress` at a time:',
  '',
  '1. "Master code review — full merged diff": call the `run_master_review` tool ONCE to get an',
  '   independent review over the whole merged diff, then read its findings.',
  '2. "Apply fixes across threads": fix whatever the review found — the smallest safe change per',
  '   finding, never expand scope, skip anything unsafe rather than guessing. If the review found',
  "   nothing actionable, mark this task completed immediately with no changes — don't invent work.",
  "3. \"Verify build & full test suite\": run the repo's own build and test commands and confirm they",
  '   pass. Do this even if task 2 made no changes — a clean review still deserves a green build.',
  '',
  'Create all three tasks up front (pending), then mark each in_progress right before you start it and',
  'completed right after it finishes. Do not skip ahead or run them out of order.',
  '',
  CLOUD_SANDBOX_NOTE,
].join('\n');

/** The Codex system prompt for the ONE holistic master-review pass `run_master_review` kicks off. */
const MASTER_REVIEW_SYSTEM_PROMPT =
  'You are a precise, terse senior code reviewer doing a final pass on a feature branch before its pull ' +
  'request opens. Report real, in-scope issues in prose — correctness bugs, security issues, and seams ' +
  'where separately-built pieces of this feature integrate badly with each other. This is a READ-ONLY ' +
  'review — do not modify any files. ' +
  CLOUD_SANDBOX_NOTE;

/**
 * Commit message for the ledger-only commit that records durable decisions into `.atlas/decisions/`
 * (passed as `ShipInput.commitMessage` on the full path + boot recovery; the direct path uses its own).
 * Shared so the driver and the brain don't drift on the string.
 */
export const LEDGER_COMMIT_MESSAGE =
  'Atlas: record durable decisions in .atlas/decisions';

/** The opened (or pre-existing) pull request. */
export interface ShipResult {
  url: string;
  number: number;
  existing: boolean;
}

/** The slice of the decision record the ship step needs (overview + decisions → the PR body). */
export type ShipRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;

export interface ShipInput {
  job: Job;
  record: ShipRecord | null;
  repo: ResolvedRepo;
  sandbox: FeatureSandbox;
  /**
   * When set, stage + commit any uncommitted worktree changes under this message BEFORE shipping. The
   * thread-driver omits it (it commits per-step); the direct-build fast path sets it (the brain wrote
   * the change but hasn't committed). A clean tree → no-op.
   */
  commitMessage?: string;
  /** Optional surface relay for the "PR ready" / "no token" notices (best-effort). */
  notify?: (message: string) => Promise<void> | void;
}

/**
 * The shared TERMINAL "ship" sequence — extracted from the thread-driver's PR-tail so BOTH the full
 * thread build and the direct-build fast path finalize identically:
 *
 *   PR-tail auto-fix (whole accumulated diff) → push the branch → open ONE PR (idempotent; a re-run
 *   finds the existing PR) → record `pr_url`/`pr_number` on the THREAD (which flips it to `done`, so the
 *   merge poll watches it) → relay "PR ready".
 *
 * References NO threads/steps — its only inputs are the job row, the (optional) decision record, the
 * resolved repo, and the sandbox. Returns the opened PR, or `null` when no GitHub token is configured
 * (the caller is notified; the thread stays `running` so a later token + re-run can ship it).
 */
@Injectable()
export class BuildShipService {
  private readonly logger = new Logger(BuildShipService.name);

  constructor(
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly store: DriverStoreService,
    // The @Global durable-block writer — for the PR Review anchor row (paired with a `notify` post).
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
    // The @Global shared transcript spine — the PR Review orchestrator rides it like a build thread, on
    // the stable `pr-review:<jobId>` lane.
    private readonly turnHarness: TurnHarnessFactory,
    // Direct engine access (not `TurnRunnerService` — build turns pass no tool bridge; the orchestrator
    // needs one for `run_master_review`), same seam the brain uses for its own host-tool turns.
    @Inject(ENGINE_RUNNER) private readonly engine: EngineRunnerPort,
  ) {}

  async ship(input: ShipInput): Promise<ShipResult | null> {
    const { job, record, repo, sandbox } = input;
    const notify = async (m: string): Promise<void> => {
      try {
        await input.notify?.(m);
      } catch (err) {
        this.logger.debug(`ship notify failed (continuing): ${err}`);
      }
    };

    if (input.commitMessage) {
      const sha = await this.git.commitAll(
        sandbox.worktreePath,
        input.commitMessage,
      );
      this.logger.log(
        `job=${job.id} ship — committed ${sha ? sha.slice(0, 8) : '(nothing to commit)'}`,
      );
    }

    this.logger.log(`job=${job.id} ship — PR Review`);
    await this.runPrReview(job, record, repo, sandbox, notify);

    if (!repo.token) {
      this.logger.warn(
        `job=${job.id}: no GitHub token — cannot push / open PR. Leaving as running.`,
      );
      await notify(
        ':warning: Build complete but no GitHub token is configured — PR not opened.',
      );
      return null;
    }

    await this.git.push(sandbox);
    const opened = await this.pr.openPullRequest(repo.token, {
      owner: repo.owner,
      repo: repo.repo,
      head: sandbox.branch,
      base: repo.defaultBranch,
      title: job.title ?? 'Atlas build',
      body: shipPrBody(job, record),
      draft: false,
    });

    // The PR (url + number) lives on the THREAD now — one owner — so the merge poll watches it there.
    await this.store.setPrReady(job.id, opened.url, opened.number);
    await this.store.setPrReviewStatus(job.id, 'opened').catch(() => undefined);
    this.logger.log(
      `thread=${job.id} PR ${opened.existing ? 'existing' : 'ready'}: ${opened.url}`,
    );
    await notify(`:tada: PR ready for review: ${opened.url}`);
    return opened;
  }

  /**
   * PR REVIEW — a single Claude orchestrator session, on the stable `pr-review:<jobId>` lane, that
   * maintains its own live task list (native `TaskCreate`/`TaskUpdate`) through three stages: get an
   * independent review over the whole diff (via the `run_master_review` host tool, which fires ONE
   * synchronous Codex pass — Codex has no custom-tool pathway in this codebase, so it can only be the
   * reviewer, not the orchestrator), apply fixes, then verify the build. Best-effort: a failure here is
   * logged and the PR opens anyway (never blocks shipping — same posture as the auto-fix pass it replaces).
   */
  private async runPrReview(
    job: Job,
    record: ShipRecord | null,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    notify: (m: string) => Promise<void>,
  ): Promise<void> {
    await this.store.startPrReview(job.id).catch(() => undefined);
    await notify(':mag: PR Review — reviewing the whole PR diff.');
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'pr_review_anchor',
        text: 'PR Review — the whole PR diff',
        meta: { prReviewAnchor: true, jobId: job.id },
      })
      .catch((err) => this.logger.debug(`pr_review_anchor append failed for job=${job.id}: ${err}`));

    const target = this.targetFor(sandbox);
    // `prReviewId` tags every durable block from this session — the discriminator a future PR-Review
    // transcript view would peel on, same role `phaseId`/`autofixId` play for build/lens blocks.
    const harness = this.turnHarness.create({
      jobId: job.id,
      channel: job.repoId,
      lane: prReviewLane(job.id),
      metaTag: { prReviewId: job.id },
    });
    try {
      await this.store.setPrReviewStatus(job.id, 'running').catch(() => undefined);
      const res = await this.engine.run({
        engine: 'claude',
        task: `Run PR Review for **${job.title ?? 'this feature'}**. Diff range: origin/${repo.defaultBranch}...HEAD.`,
        cwd: sandbox.worktreePath,
        systemPrompt: PR_REVIEW_SYSTEM_PROMPT,
        sandboxKey: `${shipSandboxKey(sandbox)}--pr-review`,
        mode: 'execute',
        richStream: true,
        onEvent: (e) => harness.onEvent(e),
        ...(target ? { target } : {}),
        toolBridge: { jobId: job.id, tools: this.buildPrReviewTools(job, repo, sandbox) },
      });
      await harness.finish(res.result, res.usage ? { usage: res.usage } : undefined);
    } catch (err) {
      await harness.abort().catch(() => undefined);
      this.logger.warn(`PR Review failed (continuing to open the PR anyway): ${err}`);
      await this.store.setPrReviewStatus(job.id, 'failed').catch(() => undefined);
    }
  }

  /** The one host tool the PR Review orchestrator gets: an independent Codex pass over the whole diff. */
  private buildPrReviewTools(
    job: Job,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Record<string, ToolImpl> {
    const runMasterReview: ToolImpl = async () => {
      const target = this.targetFor(sandbox);
      try {
        const res = await this.engine.run({
          engine: 'codex',
          task:
            `Review the diff \`git diff origin/${repo.defaultBranch}...HEAD\` — the WHOLE merged feature ` +
            'across every build thread. Look for correctness bugs, security issues, and integration seams ' +
            'where separately-built pieces of this feature don\'t fit together cleanly.',
          cwd: sandbox.worktreePath,
          systemPrompt: MASTER_REVIEW_SYSTEM_PROMPT,
          sandboxKey: `${shipSandboxKey(sandbox)}--master-review`,
          mode: 'review',
          ...(target ? { target } : {}),
        });
        return { ok: true, report: res.result };
      } catch (err) {
        return { ok: false, reason: `master review failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    };
    return { run_master_review: runMasterReview };
  }

  /** The execution target for a turn — the sandbox container when the driver ran in docker mode. */
  private targetFor(sandbox: FeatureSandbox): ExecutionTarget | undefined {
    if (!sandbox.containerId) return undefined;
    return {
      containerId: sandbox.containerId,
      worktreeHost: sandbox.worktreePath,
      ...(sandbox.execUser ? { user: sandbox.execUser } : {}),
    };
  }
}

/** The PR body — feature title, decision-record overview, and the locked decisions. */
function shipPrBody(job: Job, record: ShipRecord | null): string {
  const lines = [`Automated by Atlas v2 for **${job.title}**.`, ''];
  if (record?.overview) lines.push(record.overview, '');
  if (record?.decisions.length) {
    lines.push('### Decisions');
    for (const d of record.decisions)
      lines.push(`- **${d.title}** (${d.decisionClass}): ${d.ruling}`);
  }
  return lines.join('\n');
}

/** The per-feature auto-fix key: stable across a feature's turns (`<repoId>--<branch>`). */
function shipSandboxKey(sandbox: FeatureSandbox): string {
  return `${sandbox.repoId}--${sandbox.branch}`;
}
