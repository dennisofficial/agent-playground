import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { GithubPrService, parseGithubRepoUrl } from '../git/github-pr.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity } from '../persistence/entities';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';

/**
 * The BATCHED base-move mergeability refresh — the GraphQL counterpart to `GitStateReconciler`'s per-PR
 * REST poll. A push to a repo's DEFAULT branch can silently conflict EVERY open PR against it (GitHub
 * emits no per-PR webhook for a base-induced conflict), so re-checking each PR over REST is O(N) per push
 * — O(N²) across a sequential merge of N PRs. `schedule(orgId, repoId)` coalesces a burst of such pushes
 * (mirrors `GithubCiStateSync`'s per-key debounce) into ONE `listOpenPullMergeability` GraphQL query per
 * repo, on the SEPARATE GraphQL rate-limit budget ({@link GithubPrService.isGraphqlRateLimited}).
 *
 * `refresh` writes `pr_mergeable` on the owning job only on change (mirrors the reconciler's write) and
 * routes a `dirty` result to `StimulusIntake` with the SAME `conflict:<pr>:<headSha>` dedupe key the
 * reconciler uses, so a base-move conflict is delivered exactly once regardless of which path (batch or
 * poll) observes it first. A PR GitHub is still computing (`unknown`) gets ONE bounded re-schedule per
 * repo until it resolves, capped so a stuck repo can't retry forever.
 */
@Injectable()
export class BaseMoveMergeabilitySync {
  private readonly logger = new Logger(BaseMoveMergeabilitySync.name);
  // Two independent timer maps keyed by `${orgId}:${repoId}`: `debounceTimers` coalesces a burst of
  // real base-move pushes; `retryTimers` polls a still-computing PR. Kept separate so a fresh push can
  // never displace an in-flight retry (or vice versa) — the bug that a single shared map would cause.
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly unknownRetries = new Map<string, number>();
  private static readonly DEBOUNCE_MS = 5_000;
  private static readonly UNKNOWN_RETRY_MS = 8_000;
  private static readonly MAX_UNKNOWN_RETRIES = 3;

  constructor(
    private readonly intake: StimulusIntake,
    private readonly creds: CredentialResolver,
    private readonly pr: GithubPrService,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  /** Coalesce a burst of default-branch pushes per repo into ONE `refresh` ~5s later (fire-and-forget). */
  schedule(orgId: string, repoId: string): void {
    const key = `${orgId}:${repoId}`;
    // A fresh push starts a new refresh cycle — cancel any in-flight computing-retry and reset its budget
    // so a genuinely new base move is never starved by a prior PR's exhausted retry count.
    this.clearTimer(this.retryTimers, key);
    this.unknownRetries.delete(key);
    this.clearTimer(this.debounceTimers, key);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.refresh(orgId, repoId).catch((e) =>
        this.logger.warn(`base-move mergeability sync ${key}: ${e}`),
      );
    }, BaseMoveMergeabilitySync.DEBOUNCE_MS);
    timer.unref?.();
    this.debounceTimers.set(key, timer);
  }

  private async refresh(orgId: string, repoId: string): Promise<void> {
    // GraphQL is paused (its own, separate budget from REST) — the next push (or a later poll) catches up.
    if (this.pr.isGraphqlRateLimited()) return;

    const repo = await this.repos.findOne({ where: { id: repoId } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.hostGithubToken(orgId);
    if (!repo || !parsed || !token) return;

    const results = await this.pr.listOpenPullMergeability(token, {
      owner: parsed.owner,
      repo: parsed.repo,
      base: repo.default_branch,
    });

    let sawUnknown = false;
    for (const result of results) {
      const stillComputing = result.mergeableState === 'unknown';
      if (stillComputing) sawUnknown = true;

      const job = await this.jobs.findOne({
        where: { repo_id: repoId, pr_number: result.number },
      });
      if (!job) continue;

      if (job.pr_mergeable !== result.mergeableState) {
        await this.jobs.update({ id: job.id }, { pr_mergeable: result.mergeableState });
      }

      if (stillComputing) continue;

      // MERGE CONFLICT from the base move — same dedupe key + correlation the reconciler uses, so a
      // conflict already caught by the poll (or vice versa) is delivered exactly once.
      if (result.mergeableState === 'dirty' && result.headSha) {
        await this.intake.intakeEvent({
          orgId,
          repoId,
          source: 'github',
          dedupeKey: `conflict:${result.number}:${result.headSha}`,
          severity: 'critical',
          eventKind: 'ci_failure',
          body:
            `Your PR #${result.number} has a merge conflict against its base branch. ` +
            `Fetch the base, resolve the conflicts in the sandbox, and push the fix.${
              job.pr_url ? `\n${job.pr_url}` : ''
            }`,
          correlation: { prNumber: result.number },
        });
      }
    }

    if (sawUnknown) this.scheduleUnknownRetry(orgId, repoId);
    else this.unknownRetries.delete(`${orgId}:${repoId}`);
  }

  /** Bounded re-schedule for a repo with a still-computing (`unknown`) PR — retries until it resolves. */
  private scheduleUnknownRetry(orgId: string, repoId: string): void {
    const key = `${orgId}:${repoId}`;
    const retries = (this.unknownRetries.get(key) ?? 0) + 1;
    if (retries > BaseMoveMergeabilitySync.MAX_UNKNOWN_RETRIES) {
      this.unknownRetries.delete(key);
      return;
    }
    this.unknownRetries.set(key, retries);
    this.clearTimer(this.retryTimers, key);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.refresh(orgId, repoId).catch((e) =>
        this.logger.warn(`base-move mergeability sync ${key}: ${e}`),
      );
    }, BaseMoveMergeabilitySync.UNKNOWN_RETRY_MS);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  private clearTimer(map: Map<string, NodeJS.Timeout>, key: string): void {
    const existing = map.get(key);
    if (existing) {
      clearTimeout(existing);
      map.delete(key);
    }
  }
}
