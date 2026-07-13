import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, MessageEntity, RepoEntity } from '../persistence/entities';
import { GithubPrService, parseGithubRepoUrl } from '../git/github-pr.service';
import { CredentialResolver } from '../onboarding';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { JobLifecycleService } from './job-lifecycle.service';
import { DriverStoreService } from './driver-store.service';

/**
 * GitHub-state readiness — the part shared by manual + auto (the manual "Merge PR" card/button uses THIS
 * same gate, via `DriverStoreService.getPipelineState`). Deliberately NOT the auto-merge decision itself:
 * whether to auto-CLICK it also needs {@link AutoMergeService.maybeAutoMerge}'s brain-settled guard.
 */
export function prMergeReady(job: {
  pr_state: string | null;
  pr_number: number | null;
  pr_mergeable: string | null;
  ci_status: string | null;
}): boolean {
  return (
    job.pr_state === 'open' &&
    job.pr_number != null &&
    job.pr_mergeable === 'clean' &&
    job.ci_status !== 'failure' &&
    job.ci_status !== 'pending' // success | skipped | null (no checks reported) all pass
  );
}

/**
 * Per-job AUTO-MERGE — the evaluator that decides whether a merge-ready PR merges itself, and the ONE
 * resolution path ({@link mergeNow}) both the auto path and a manual "Merge PR" click land on. Posts the
 * durable Merge-PR card whenever GitHub reports the PR clean (regardless of the job's `auto_merge`
 * toggle — a human can always click); only auto-clicks it when `auto_merge` is on AND the brain has
 * fully settled (see {@link brainSettled}).
 *
 * Deliberately does NOT inject `StimulusIntake` — auto-merge never seeds the brain (Decision d1): a merge
 * rejection relies on the EXISTING reconciler dirty→brain routing rather than double-seeding a turn.
 */
@Injectable()
export class AutoMergeService {
  private readonly logger = new Logger(AutoMergeService.name);
  /** In-process single-flight guard against a concurrent double-merge of the same job (the reconciler tick,
   *  the CI-sync webhook, and a brain-turn-end trigger can all fire close together). */
  private readonly inFlight = new Set<string>();

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    private readonly lifecycle: JobLifecycleService,
    private readonly turns: TurnRegistry,
    private readonly stimulusStore: StimulusStoreService,
    // forwardRef breaks the driver-store.service.ts ⇄ auto-merge.service.ts file cycle (driver-store's
    // getPipelineState calls `prMergeReady` from here): without it, TS's emitted `design:paramtypes`
    // captures `undefined` for this slot because driver-store.service.ts hasn't finished exporting its
    // class yet at the point this module's decorator runs.
    @Inject(forwardRef(() => DriverStoreService))
    private readonly driverStore: DriverStoreService,
  ) {}

  /** Brain settled — the AUTO-only extra guard on top of {@link prMergeReady}. MUST include the durable
   *  pending-chat queue (not just the in-flight turn), else a merge could land while undelivered operator
   *  messages are still queued for the next turn. */
  private async brainSettled(job: JobEntity): Promise<boolean> {
    const idle =
      job.activity === 'idle' &&
      !job.halted &&
      job.halt == null &&
      job.open_question_count === 0 &&
      job.awaiting_secret_id == null;
    if (!idle) return false;
    if ((await this.turns.runningBrainTurn(job.id)) != null) return false;
    return !(await this.stimulusStore.hasUndeliveredChat(job.id));
  }

  /** The evaluator the three triggers call (reconciler tick / CI-sync webhook / brain turn-end). Idempotent:
   *  safe to call repeatedly for the same job. */
  async maybeAutoMerge(jobId: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job) return;
    if (!prMergeReady(job)) {
      await this.driverStore.neutralizeMergeCard(jobId).catch(() => undefined);
      return;
    }
    // GitHub-mergeable → the manual Merge PR card appears regardless of auto_merge (a human can always click).
    await this.driverStore.postMergeCard(jobId).catch(() => undefined);
    if (!job.auto_merge) return;
    if (!(await this.brainSettled(job))) return;
    try {
      const approver = await this.resolveApprover(job);
      await this.mergeNow(jobId, approver);
    } catch (err) {
      this.logger.warn(`auto-merge could not resolve an approver for job ${jobId}: ${err}`);
    }
  }

  private async resolveApprover(job: JobEntity): Promise<string> {
    if (job.auto_merge_by) return job.auto_merge_by;
    const owner = await this.driverStore.ownerUserId(job.org_id);
    if (!owner) throw new Error(`no auto-merge approver for job ${job.id} (no auto_merge_by and no org owner)`);
    return owner;
  }

  /** The ONE resolution path — a manual "Merge PR" click and the auto path both land here. Returns true
   *  iff the PR was actually merged (or was already merged) by this call. */
  async mergeNow(jobId: string, ruledBy: string): Promise<boolean> {
    if (this.inFlight.has(jobId)) return false;
    this.inFlight.add(jobId);
    try {
      const job = await this.jobs.findOneBy({ id: jobId });
      if (!job || !prMergeReady(job)) return false; // re-check under the guard
      const repo = await this.repos.findOne({ where: { id: job.repo_id } });
      const parsed = repo ? parseGithubRepoUrl(repo.git_url) : null;
      const token = await this.creds.githubToken(job.org_id);
      if (!parsed || !token) return false;
      const detail = await this.pr.getPullDetail(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        number: job.pr_number!,
      });
      const result = await this.pr.mergePullRequest(token, {
        owner: parsed.owner,
        repo: parsed.repo,
        number: job.pr_number!,
        method: job.auto_merge_method,
        sha: detail.headSha ?? undefined,
      });
      if (result.ok || result.reason === 'already_merged') {
        if (job.auto_merge_delete_branch && job.feature_branch) {
          await this.pr
            .deleteBranch(token, { owner: parsed.owner, repo: parsed.repo, branch: job.feature_branch })
            .catch(() => undefined);
        }
        await this.lifecycle.applyGithubPrState(job, 'merged'); // pr_state='merged' + teardown
        await this.driverStore.neutralizeMergeCard(jobId).catch(() => undefined);
        this.logger.log(
          `merged PR #${job.pr_number} (${job.auto_merge_method}) for job ${jobId}, ruled by ${ruledBy}`,
        );
        return true;
      }
      // FAILURE — do NOT seed the brain (Decision d1, race-avoidance). We only got here because the
      // eligibility gate already saw pr_mergeable==='clean', so a rejection means the state moved in the
      // window between the check and the PUT. Rely on the EXISTING reconciler dirty→brain routing (already
      // deduped) to wake the brain — auto-merge must NOT double-seed a turn on top of it.
      if (result.reason === 'method_disallowed') {
        await this.postMethodDisallowedNoteOnce(job, result.message);
      } else {
        this.logger.warn(
          `auto-merge of PR #${job.pr_number} rejected (${result.reason} ${result.status}: ${result.message}) — no-op, relying on existing routing`,
        );
      }
      return false;
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  /** One-time, deduped OPERATOR-facing chat note when GitHub rejects the configured merge method (422) — a
   *  visible line, NOT a brain seed, so the operator can switch methods or merge manually. Keyed by a fixed
   *  `ts` so repeated rejections (the reconciler re-evaluates constantly) don't spam the transcript. */
  private async postMethodDisallowedNoteOnce(job: JobEntity, message: string): Promise<void> {
    const ts = `automerge-method:${job.id}`;
    const existing = await this.messages.findOne({ where: { job_id: job.id, ts } });
    if (existing) return;
    await this.messages
      .save(
        this.messages.create({
          job_id: job.id,
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: `Auto-merge is on, but GitHub rejected the "${job.auto_merge_method}" merge method for PR #${job.pr_number}: ${message}. Pick a different method, or merge manually.`,
          kind: 'build_event',
          ts,
        }),
      )
      .catch((err) => this.logger.warn(`postMethodDisallowedNoteOnce failed for job ${job.id}: ${err}`));
  }
}
