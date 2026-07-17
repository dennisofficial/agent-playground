import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Raw, Repository } from 'typeorm';
import {
  CheckRun,
  CiCounts,
  CiSummary,
  GithubPrService,
  parseGithubRepoUrl,
} from '../git/github-pr.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';
import { AutoMergeService } from './auto-merge.service';

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
    @Optional()
    private readonly autoMerge?: AutoMergeService,
  ) {}

  async tick(): Promise<number> {
    if (this.pr.isRateLimited()) return 0;

    const due = Raw((alias) => `(${alias} IS NULL OR ${alias} <= now())`);
    const jobs = await this.jobs.find({
      where: [
        { pr_number: Not(IsNull()), next_poll_at: due },
        {
          feature_branch: Not(IsNull()),
          pr_number: IsNull(),
          next_poll_at: due,
        },
      ],
    });
    let reconciled = 0;
    for (const job of jobs) {
      let tier: PollTier = 'active';
      try {
        tier = await this.reconcileOne(job);
        reconciled++;
      } catch (err) {
        this.logger.warn(`git-state reconcile failed for job ${job.id}: ${err}`);
        if (this.pr.isRateLimited()) continue;
      }
      await this.setNextPoll(job.id, tier);
    }
    return reconciled;
  }

  async markRepoDue(orgId: string, repoId: string): Promise<number> {
    const res = await this.jobs.update(
      { org_id: orgId, repo_id: repoId, pr_state: 'open' },
      { next_poll_at: new Date() },
    );
    const marked = res.affected ?? 0;
    if (marked > 0) {
      this.logger.log(
        `base-branch push on repo ${repoId} — marked ${marked} open PR(s) due for re-poll`,
      );
    }
    return marked;
  }

  async markJobDue(
    orgId: string,
    repoId: string,
    opts: { prNumber?: number | null; branch?: string | null },
  ): Promise<number> {
    const stamp = { next_poll_at: new Date() };
    const baseWhere = { org_id: orgId, repo_id: repoId };
    let target: string | null = null;
    let marked = 0;
    if (opts.prNumber != null) {
      target = `pr #${opts.prNumber}`;
      const res = await this.jobs.update({ ...baseWhere, pr_number: opts.prNumber }, stamp);
      marked = res.affected ?? 0;
    }
    if (marked === 0 && opts.branch) {
      target = `branch ${opts.branch}`;
      const res = await this.jobs.update({ ...baseWhere, feature_branch: opts.branch }, stamp);
      marked = res.affected ?? 0;
    }
    if (!target) {
      return 0;
    }
    if (marked > 0) {
      this.logger.log(`re-armed ${marked} job(s) due for re-poll (${target})`);
    }
    return marked;
  }

  private async setNextPoll(jobId: string, tier: PollTier): Promise<void> {
    const next = tier === 'terminal' ? null : new Date(Date.now() + CADENCE_MS[tier]);
    await this.jobs.update({ id: jobId }, { next_poll_at: next });
  }

  private async reconcileOne(job: JobEntity): Promise<PollTier> {
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.hostGithubToken(job.org_id);
    if (!parsed || !token) return 'discovering';

    let prNumber = job.pr_number;
    if (prNumber == null) {
      if (!job.feature_branch) return 'discovering';
      const found = await this.pr.findOpenPullByHead(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        head: job.feature_branch,
      });
      if (!found) return 'discovering';
      await this.jobs.update(
        { id: job.id },
        {
          pr_url: found.url,
          pr_number: found.number,
          status: 'done',
          pr_state: 'open',
        },
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

    const nextPrState = detail.state === 'gone' ? 'closed' : detail.state;
    if (nextPrState !== job.pr_state) {
      await this.jobs.update({ id: job.id }, { pr_state: nextPrState });
      job.pr_state = nextPrState;
    }

    if (detail.state !== 'open') return 'terminal';

    let sum: CiSummary = {
      status: job.ci_status as CiSummary['status'],
      counts: job.ci_counts,
    };
    if (detail.headSha) {
      const runs = await this.pr.listCheckRuns(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: detail.headSha,
      });
      if (runs.length > 0) sum = summarizeChecks(runs);
    }

    const ciChanged = sum.status !== job.ci_status || !sameCounts(sum.counts, job.ci_counts);
    if (ciChanged || detail.mergeableState !== job.pr_mergeable) {
      await this.jobs.update(
        { id: job.id },
        {
          ci_status: sum.status,
          ci_counts: sum.counts,
          pr_mergeable: detail.mergeableState,
        },
      );
    }

    if (detail.mergeableState === 'dirty' && detail.headSha) {
      await this.intake.intakeEvent({
        orgId: job.org_id,
        repoId: job.repo_id,
        source: 'github',
        dedupeKey: `conflict:${prNumber}:${detail.headSha}`,
        severity: 'critical',
        eventKind: 'ci_failure',
        body:
          `Your PR #${prNumber} has a merge conflict against its base branch. ` +
          `Fetch the base, resolve the conflicts in the sandbox, and push the fix.\n${detail.url}`,
        correlation: { prNumber },
      });
    }

    void this.autoMerge
      ?.maybeAutoMerge(job.id)
      .catch((err) => this.logger.warn(`maybeAutoMerge failed for job ${job.id}: ${err}`));

    return detail.mergeableState == null || detail.mergeableState.toLowerCase() === 'unknown'
      ? 'computing'
      : 'active';
  }
}

export type PollTier = 'computing' | 'active' | 'discovering' | 'terminal';
export const CADENCE_MS: Record<Exclude<PollTier, 'terminal'>, number> = {
  computing: 8_000,
  active: 900_000,
  discovering: 180_000,
};

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'stale']);

export function summarizeChecks(runs: CheckRun[]): CiSummary {
  if (runs.length === 0) return { status: null, counts: null };
  const counts: CiCounts = {
    failing: 0,
    pending: 0,
    passed: 0,
    skipped: 0,
    total: runs.length,
  };
  for (const r of runs) {
    if (r.status !== 'completed') counts.pending++;
    else if (r.conclusion != null && FAILED.has(r.conclusion)) counts.failing++;
    else if (r.conclusion === 'success') counts.passed++;
    else counts.skipped++; // skipped | neutral | any other non-failing terminal conclusion
  }
  const status =
    counts.failing > 0
      ? 'failure'
      : counts.pending > 0
        ? 'pending'
        : counts.passed > 0
          ? 'success'
          : 'skipped';
  return { status, counts };
}

export function sameCounts(a: CiCounts | null, b: CiCounts | null): boolean {
  if (a == null || b == null) return a === b;
  return (
    a.failing === b.failing &&
    a.pending === b.pending &&
    a.passed === b.passed &&
    a.skipped === b.skipped &&
    a.total === b.total
  );
}
