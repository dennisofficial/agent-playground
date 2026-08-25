import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { CiSyncDelta } from '../../_shared/domain';
import { GithubPrService, parseGithubRepoUrl } from '../git/github-pr.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { AutoMergeService } from './auto-merge.service';
import { sameCounts, summarizeChecks } from './git-state-reconciler.service';

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
    @Optional()
    private readonly autoMerge?: AutoMergeService,
  ) {}

  schedule(delta: CiSyncDelta): void {
    const key = `${delta.orgId}:${delta.repoId}:${delta.prNumber ?? delta.branch ?? '?'}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.recompute(delta).catch((e) => this.logger.warn(`ci-sync ${key}: ${e}`));
    }, GithubCiStateSync.DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async recompute(delta: CiSyncDelta): Promise<void> {
    if (this.pr.isRateLimited()) return;

    const job =
      (delta.prNumber != null
        ? await this.stimStore.findOwningJobByPrNumber(delta.orgId, delta.repoId, delta.prNumber)
        : null) ??
      (delta.branch
        ? await this.stimStore.findOwningJobByBranch(delta.orgId, delta.repoId, delta.branch)
        : null);
    if (!job) return; // route-only: unowned CI is a no-op
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.hostGithubToken(job.org_id);
    if (!parsed || !token) return;

    let prNumber = job.pr_number;
    if (prNumber == null) {
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
    if (runs.length === 0) return;
    const sum = summarizeChecks(runs);
    if (
      sum.status !== job.ci_status ||
      !sameCounts(sum.counts, job.ci_counts) ||
      detail.mergeableState !== job.pr_mergeable
    )
      await this.jobs.update(
        { id: job.id },
        {
          ci_status: sum.status,
          ci_counts: sum.counts,
          pr_mergeable: detail.mergeableState,
        },
      );
    void this.autoMerge
      ?.maybeAutoMerge(job.id)
      .catch((err) => this.logger.warn(`maybeAutoMerge failed for job ${job.id}: ${err}`));
  }
}
