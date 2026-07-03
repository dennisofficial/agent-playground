import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { GithubPrService, parseGithubRepoUrl, type CheckRun } from '../git';
import { StimulusIntake } from '../stimulus';

/**
 * The GIT-STATE RECONCILER — the poll half of "host observes GitHub, Atlas acts". Runs on the driver's
 * leader-gated reap timer. For every job with an open PR it:
 *
 *  - refreshes the UI columns `ci_status` (from the head-SHA check-runs) + `pr_mergeable` (GitHub's
 *    computed `mergeable_state`), and
 *  - routes a **merge-conflict** back to the owning job's brain when `mergeable_state === 'dirty'` — the
 *    flagship signal GitHub does NOT emit as a clean webhook, so the poll is the ONLY way to catch it.
 *
 * Routing goes through {@link StimulusIntake.intakeEvent} with a PR correlation hint, so the conflict
 * lands as a harness message on THIS job's session (dedup on the `stimuli` unique index → delivered
 * exactly once per conflicting head SHA; a pushed fix that stays conflicted re-notifies on the new SHA).
 *
 * CI-FAILURE routing rides the webhook (`check_run`) to avoid double-delivery — here we only keep the
 * `ci_status` column fresh for the UI badge. Merged/closed PRs are left to `pollPrClosures` (teardown).
 */
@Injectable()
export class GitStateReconciler {
  private readonly logger = new Logger(GitStateReconciler.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    private readonly intake: StimulusIntake,
  ) {}

  /**
   * Reconcile every job with a PR OR a branch that might have one — a `pr_number` job is polled for
   * conflict/CI; a branch-only job is checked for a PR opened in-sandbox by Atlas (discovery). Returns
   * the count reconciled. Fail-soft per job.
   */
  async reconcile(): Promise<number> {
    const jobs = await this.jobs.find({
      where: [{ pr_number: Not(IsNull()) }, { feature_branch: Not(IsNull()), pr_number: IsNull() }],
    });
    let reconciled = 0;
    for (const job of jobs) {
      try {
        await this.reconcileOne(job);
        reconciled++;
      } catch (err) {
        this.logger.warn(`git-state reconcile failed for job ${job.id}: ${err}`);
      }
    }
    return reconciled;
  }

  private async reconcileOne(job: JobEntity): Promise<void> {
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.githubToken(job.org_id);
    if (!parsed || !token) return;

    // PR DISCOVERY: a job with a branch but no recorded PR — pick up a PR Atlas opened in-sandbox and
    // record it so the merge poll + conflict/CI observation start watching it.
    let prNumber = job.pr_number;
    if (prNumber == null) {
      if (!job.feature_branch) return;
      const found = await this.pr.findOpenPullByHead(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        head: job.feature_branch,
      });
      if (!found) return;
      // Record the PR AND flip the job to `done` — the invariant "PR recorded ⇒ job done" used to be set
      // host-side by `setPrReady` when the host opened the PR. Now Atlas opens it in-sandbox and the host
      // learns of it here, on discovery, so this is where the flip belongs.
      await this.jobs.update(
        { id: job.id },
        { pr_url: found.url, pr_number: found.number, status: 'done', pr_state: 'open' },
      );
      job.pr_state = 'open';
      this.logger.log(`discovered PR #${found.number} for job ${job.id} on ${job.feature_branch}`);
      prNumber = found.number;
    }

    const detail = await this.pr.getPullDetail(token, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: prNumber,
    });

    // Backfill the PR lifecycle column (safety net for legacy rows with a null pr_state, and for the
    // authoritative merged/closed latch in pollPrClosures). `gone` reads as closed. Only write on change.
    const nextPrState = detail.state === 'gone' ? 'closed' : detail.state;
    if (nextPrState !== job.pr_state) {
      await this.jobs.update({ id: job.id }, { pr_state: nextPrState });
      job.pr_state = nextPrState;
    }

    // Merged / closed / gone → pollPrClosures owns teardown; nothing more to observe here.
    if (detail.state !== 'open') return;

    // CI status column (UI badge). Routing of CI FAILURES rides the webhook (check_run) so it isn't
    // double-delivered; here we only summarise the head-SHA check-runs into the column.
    let ci = job.ci_status;
    if (detail.headSha) {
      const runs = await this.pr.listCheckRuns(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: detail.headSha,
      });
      ci = summarizeChecks(runs);
    }

    // Persist observed columns only when they changed — avoid needless WAL/realtime deltas.
    if (ci !== job.ci_status || detail.mergeableState !== job.pr_mergeable) {
      await this.jobs.update({ id: job.id }, { ci_status: ci, pr_mergeable: detail.mergeableState });
    }

    // MERGE CONFLICT — `dirty` = the PR no longer merges cleanly into its base. Route to the owning
    // brain so Atlas fetches base, resolves in the sandbox, and pushes. `null` mergeable_state means
    // GitHub is still computing it → skip this pass (a later reconcile catches it).
    if (detail.mergeableState === 'dirty' && detail.headSha) {
      await this.intake.intakeEvent({
        orgId: job.org_id,
        repoId: job.repo_id,
        source: 'github',
        dedupeKey: `conflict:${prNumber}:${detail.headSha}`,
        severity: 'critical',
        body:
          `Your PR #${prNumber} has a merge conflict against its base branch. ` +
          `Fetch the base, resolve the conflicts in the sandbox, and push the fix.\n${detail.url}`,
        correlation: { prNumber },
      });
    }
  }
}

/** Roll a PR head's check-runs into a single UI status. null = no checks reported. */
export function summarizeChecks(runs: CheckRun[]): string | null {
  if (runs.length === 0) return null;
  const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale']);
  if (runs.some((r) => r.status === 'completed' && r.conclusion != null && FAILED.has(r.conclusion))) {
    return 'failure';
  }
  if (runs.every((r) => r.status === 'completed')) return 'success';
  return 'pending';
}
