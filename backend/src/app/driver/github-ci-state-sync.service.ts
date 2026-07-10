import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { CiSyncDelta } from '../domain';
import { GithubPrService, parseGithubRepoUrl } from '../git';
import { CredentialResolver } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { StimulusStoreService } from '../stimulus';
import { summarizeChecks } from './git-state-reconciler.service';

/**
 * The SILENT GitHub CI-status webhook sync — the FAST path that mirrors `GitStateReconciler.reconcileOne`'s
 * CI-column logic so the fast (webhook) and slow (30-min poll) paths can never drift. Driven by the
 * already-subscribed `check_run`/`check_suite`/`workflow_run` events, it recomputes `jobs.ci_status`
 * against the CURRENT PR head and writes only on change (WAL→SSE pushes it to the UI). It NEVER touches
 * StimulusIntake — the existing CI-failure brain-triage path is untouched. The poll remains the backstop.
 */
@Injectable()
export class GithubCiStateSync {
  private readonly logger = new Logger(GithubCiStateSync.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private static readonly DEBOUNCE_MS = 5_000;

  constructor(
    private readonly stimStore: StimulusStoreService,
    private readonly creds: CredentialResolver,
    private readonly pr: GithubPrService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  /** Coalesce a burst of CI webhooks per correlation key into ONE recompute ~5s later (fire-and-forget). */
  schedule(delta: CiSyncDelta): void {
    const key = `${delta.orgId}:${delta.repoId}:${delta.prNumber ?? delta.branch ?? '?'}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.recompute(delta).catch((e) =>
        this.logger.warn(`ci-sync ${key}: ${e}`),
      );
    }, GithubCiStateSync.DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async recompute(delta: CiSyncDelta): Promise<void> {
    // Correlate PR-number-first, then FALL BACK to branch (mirrors intake's order): during the
    // PR-open/check-run race the job may not have pr_number recorded yet, so a PR-only lookup would
    // no-op and leave ci_status stale until the poll — the branch fallback catches that.
    const job =
      (delta.prNumber != null
        ? await this.stimStore.findOwningJobByPrNumber(
            delta.orgId,
            delta.repoId,
            delta.prNumber,
          )
        : null) ??
      (delta.branch
        ? await this.stimStore.findOwningJobByBranch(
            delta.orgId,
            delta.repoId,
            delta.branch,
          )
        : null);
    if (!job) return; // route-only: unowned CI is a no-op
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.githubToken(job.org_id);
    if (!parsed || !token) return;

    // Resolve the CURRENT PR head authoritatively — NEVER the webhook's own head_sha (deliveries are
    // unordered). Mirrors GitStateReconciler.reconcileOne so fast + slow paths can't disagree.
    let prNumber = job.pr_number;
    if (prNumber == null) {
      // PR-open race: pr_number not recorded yet → discover the open PR by branch (same call the
      // reconciler uses). No open PR yet → no-op; the poll / a later webhook catches up.
      if (!delta.branch) return;
      const found = await this.pr.findOpenPullByHead(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        head: delta.branch,
      });
      if (!found) return;
      prNumber = found.number;
    }
    const detail = await this.pr.getPullDetail(token, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: prNumber,
    });
    if (detail.state !== 'open' || !detail.headSha) return; // merged/closed → CI badge is moot
    const runs = await this.pr.listCheckRuns(token, {
      owner: parsed.owner,
      repo: parsed.repo,
      ref: detail.headSha,
    });
    const ci = summarizeChecks(runs);
    if (ci !== job.ci_status)
      await this.jobs.update({ id: job.id }, { ci_status: ci }); // write ONLY on change
  }
}
