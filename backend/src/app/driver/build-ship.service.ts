import { Inject, Injectable, Logger } from '@nestjs/common';
import { AutoFixStage } from '../autofix';
import { reviewAgentsForThread } from '../autofix/autofix-lenses';
import type { DecisionRecord, Job } from '../domain';
import { GithubPrService, LocalGitService, type FeatureSandbox } from '../git';
import { BLOCK_SINK, type BlockSink } from '../surface/turn-harness.service';
import { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

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
    private readonly autofix: AutoFixStage,
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly store: DriverStoreService,
    // The @Global durable-block writer — for the PR-tail `autofix_anchor` row (paired with a `notify` post).
    @Inject(BLOCK_SINK) private readonly blockSink: BlockSink,
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

    this.logger.log(`job=${job.id} ship — PR-tail auto-fix`);
    // Job-level review agents (the "Final review" over the WHOLE diff): seed at `pending`, emit the anchor
    // (paired with a `notify` change-signal, like the per-thread pass), transition per lens, finalize after.
    const reviewAgents = reviewAgentsForThread().map((a) => ({
      ...a,
      status: 'pending' as const,
    }));
    await this.store.seedJobReviewAgents(job.id, reviewAgents).catch(() => undefined);
    await notify(':mag: Final review — reviewing the whole PR diff.');
    await this.blockSink
      .appendBlock(job.id, {
        kind: 'autofix_anchor',
        text: 'Final review — the whole PR diff',
        meta: {
          autofixId: job.id,
          autofixAnchor: true,
          scope: 'pr',
          label: 'Final review',
          lensIds: reviewAgents.map((a) => a.id),
        },
      })
      .catch((err) => this.logger.debug(`autofix_anchor append failed for job=${job.id}: ${err}`));
    let lensesRun: string[] = [];
    try {
      const summary = await this.autofix.autofixPullRequest(
        {
          worktreePath: sandbox.worktreePath,
          sandboxKey: shipSandboxKey(sandbox),
          gitRange: `origin/${repo.defaultBranch}...HEAD`,
          intent: record?.overview ?? job.title ?? '',
          label: 'PR-tail',
          // Streaming identity — ride the shared spine on `autofix:<jobId>:*` lanes.
          jobId: job.id,
          channel: job.repoId,
          autofixId: job.id,
          scope: 'pr',
          ...(sandbox.containerId
            ? {
                containerId: sandbox.containerId,
                ...(sandbox.execUser ? { execUser: sandbox.execUser } : {}),
              }
            : {}),
        },
        {
          onLensStatus: (lensId, status, findings) => {
            void this.store
              .setJobReviewAgentStatus(job.id, lensId, status, findings)
              .catch(() => undefined);
          },
        },
      );
      lensesRun = summary.lensesRun;
    } catch (err) {
      this.logger.warn(`PR-tail auto-fix failed (continuing): ${err}`);
    } finally {
      await this.store.finalizeJobReviewAgents(job.id, lensesRun).catch(() => undefined);
    }

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
    this.logger.log(
      `thread=${job.id} PR ${opened.existing ? 'existing' : 'ready'}: ${opened.url}`,
    );
    await notify(`:tada: PR ready for review: ${opened.url}`);
    return opened;
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
