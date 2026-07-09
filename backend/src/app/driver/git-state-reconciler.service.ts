import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Raw, Repository } from 'typeorm';
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
 *
 * ADAPTIVE, NEAR-REAL-TIME: `tick()` runs on a ~15s leader heartbeat but only reconciles jobs that are
 * DUE per the durable {@link JobEntity.next_poll_at} clock, which it re-stamps by an adaptive cadence
 * (see {@link CADENCE_MS}) — fast while GitHub is still computing mergeability, relaxed for a settled PR,
 * slow for a branch with no PR yet, cleared once the PR is terminal. {@link markRepoDue} lets a
 * base-branch push mark every open PR on a repo due-now so a base-move conflict surfaces in seconds (the
 * signal GitHub does NOT emit as a webhook), replacing the old fixed 30-min full sweep.
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
   * The adaptive-poll heartbeat: reconcile only the jobs whose durable `next_poll_at` clock is DUE (null
   * = never polled → due now, or `<= now()`), among those with a PR OR a branch that might have one — a
   * `pr_number` job is polled for conflict/CI; a branch-only job is checked for a PR opened in-sandbox by
   * Atlas (discovery). Each reconciled job's `next_poll_at` is re-stamped by adaptive cadence. Returns the
   * count reconciled. Fail-soft per job (a throwing job still gets re-stamped so it isn't hammered).
   */
  async tick(): Promise<number> {
    // `(next_poll_at IS NULL OR next_poll_at <= now())` — the DUE predicate, applied to both OR branches.
    const due = Raw((alias) => `(${alias} IS NULL OR ${alias} <= now())`);
    const jobs = await this.jobs.find({
      where: [
        { pr_number: Not(IsNull()), next_poll_at: due },
        { feature_branch: Not(IsNull()), pr_number: IsNull(), next_poll_at: due },
      ],
    });
    let reconciled = 0;
    for (const job of jobs) {
      // Default to `active` (45s) on an unexpected error so a persistently-failing job backs off to the
      // settled cadence rather than re-polling every heartbeat.
      let tier: PollTier = 'active';
      try {
        tier = await this.reconcileOne(job);
        reconciled++;
      } catch (err) {
        this.logger.warn(`git-state reconcile failed for job ${job.id}: ${err}`);
      }
      await this.setNextPoll(job.id, tier);
    }
    return reconciled;
  }

  /**
   * Mark every OPEN PR on a repo due-now — called when a push lands on the repo's DEFAULT branch. A
   * base-branch move can silently conflict an open PR (GitHub emits NO webhook for a base-induced
   * conflict), so we force the next heartbeat to re-poll each open PR; if GitHub returns a null
   * `mergeable_state` (recomputing), the ~8s `computing` tier polls until it resolves to clean/dirty.
   * Returns the number of PRs marked. Branch-only jobs (no PR yet) are untouched — a base move can't
   * conflict a PR that doesn't exist.
   */
  async markRepoDue(orgId: string, repoId: string): Promise<number> {
    const res = await this.jobs.update(
      { org_id: orgId, repo_id: repoId, pr_state: 'open' },
      { next_poll_at: new Date() },
    );
    const marked = res.affected ?? 0;
    if (marked > 0) {
      this.logger.log(`base-branch push on repo ${repoId} — marked ${marked} open PR(s) due for re-poll`);
    }
    return marked;
  }

  /** Re-stamp a job's durable poll clock: `terminal` clears it (stop polling), else now + adaptive cadence. */
  private async setNextPoll(jobId: string, tier: PollTier): Promise<void> {
    const next = tier === 'terminal' ? null : new Date(Date.now() + CADENCE_MS[tier]);
    await this.jobs.update({ id: jobId }, { next_poll_at: next });
  }

  /** Reconcile ONE job's GitHub state and return the cadence tier that should govern its next poll. */
  private async reconcileOne(job: JobEntity): Promise<PollTier> {
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
    const token = await this.creds.githubToken(job.org_id);
    // Misconfig (no repo URL / no token) is persistent — back off to the slow tier rather than retrying
    // every heartbeat.
    if (!parsed || !token) return 'discovering';

    // PR DISCOVERY: a job with a branch but no recorded PR — pick up a PR Atlas opened in-sandbox and
    // record it so the merge poll + conflict/CI observation start watching it.
    let prNumber = job.pr_number;
    if (prNumber == null) {
      if (!job.feature_branch) return 'discovering';
      const found = await this.pr.findOpenPullByHead(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        head: job.feature_branch,
      });
      // No PR yet — a branch still building. Nothing's visible until the build lands the PR, so poll slow.
      if (!found) return 'discovering';
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

    // Merged / closed / gone → pollPrClosures owns teardown; nothing more to observe here. Clear the
    // poll clock (`terminal`) so this job drops out of the DUE set.
    if (detail.state !== 'open') return 'terminal';

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

    // `null` mergeable_state = GitHub is still computing it — poll fast (`computing`) until it resolves to
    // clean/dirty. A settled open PR polls at the relaxed `active` cadence (CI / merge / conflict flips).
    return detail.mergeableState === null ? 'computing' : 'active';
  }
}

/**
 * The adaptive poll cadence, in ms — how soon a job is re-polled after a reconcile pass (tunable).
 *  - `computing`  — GitHub is still computing `mergeable_state`; poll until it resolves (the base-move
 *    conflict window this whole feature targets).
 *  - `active`     — a settled open PR; CI, a merge, or a fresh conflict can flip it, but not sub-second.
 *  - `discovering`— a branch still building with no PR yet; nothing's observable until the build lands.
 * `terminal` (merged/closed/gone) has no cadence — the clock is cleared and the job stops polling.
 */
export type PollTier = 'computing' | 'active' | 'discovering' | 'terminal';
export const CADENCE_MS: Record<Exclude<PollTier, 'terminal'>, number> = {
  computing: 8_000,
  active: 45_000,
  discovering: 180_000,
};

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
