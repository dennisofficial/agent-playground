import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { AutoMergeMethod } from '@workspace/shared';
import { Repository } from 'typeorm';
import { GithubPrService, parseGithubRepoUrl } from '../git/github-pr.service';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity, RepoEntity, TranscriptMessageEntity } from '../persistence/entities';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { DriverStoreService } from './driver-store.service';
import { JobLifecycleService } from './job-lifecycle.service';

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

@Injectable()
export class AutoMergeService {
  private readonly logger = new Logger(AutoMergeService.name);
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(RepoEntity, DB_CONNECTION)
    private readonly repos: Repository<RepoEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    private readonly pr: GithubPrService,
    private readonly creds: CredentialResolver,
    @Inject(forwardRef(() => JobLifecycleService))
    private readonly lifecycle: JobLifecycleService,
    private readonly turns: TurnRegistry,
    private readonly stimulusStore: StimulusStoreService,
    @Inject(forwardRef(() => DriverStoreService))
    private readonly driverStore: DriverStoreService,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
  ) {}

  private async brainSettled(job: JobEntity): Promise<boolean> {
    const idle =
      job.activity === 'idle' &&
      !job.halted &&
      job.halt == null &&
      job.open_question_count === 0 &&
      job.open_secret_count === 0 &&
      job.awaiting_secret_id == null;
    if (!idle) return false;
    if ((await this.turns.runningBrainTurn(job.id)) != null) return false;
    return !(await this.stimulusStore.hasUndeliveredChat(job.id));
  }

  async maybeAutoMerge(jobId: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job) return;
    if (!prMergeReady(job)) {
      await this.driverStore.neutralizeMergeCard(jobId, 'not-ready').catch(() => undefined);
      return;
    }
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
    if (!owner)
      throw new Error(
        `no auto-merge approver for job ${job.id} (no auto_merge_by and no org owner)`,
      );
    return owner;
  }

  async mergeNow(jobId: string, ruledBy: string): Promise<boolean> {
    const active = this.inFlight.get(jobId);
    if (active) return await active;

    const run = this.mergeNowLocked(jobId, ruledBy);
    this.inFlight.set(jobId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(jobId) === run) this.inFlight.delete(jobId);
    }
  }

  private async mergeNowLocked(jobId: string, ruledBy: string): Promise<boolean> {
    const job = await this.jobs.findOneBy({ id: jobId });
    if (!job || !prMergeReady(job)) return false; // re-check under the guard
    const repo = await this.repos.findOne({ where: { id: job.repo_id } });
    if (!repo) return false;
    const method: AutoMergeMethod = repo.default_auto_merge_method;
    if (await this.hasMethodDisallowedNote(job.id, method)) return false;
    const parsed = parseGithubRepoUrl(repo.git_url);
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
      method,
      sha: detail.headSha ?? undefined,
    });
    if (result.ok || result.reason === 'already_merged') {
      const branchToDelete = detail.headRef ?? job.feature_branch;
      if (repo.default_auto_merge_delete_branch && branchToDelete) {
        await this.pr
          .deleteBranch(token, {
            owner: parsed.owner,
            repo: parsed.repo,
            branch: branchToDelete,
          })
          .catch(() => undefined);
      }
      await this.lifecycle.applyGithubPrState(job, 'merged'); // pr_state='merged' + teardown
      await this.driverStore.neutralizeMergeCard(jobId).catch(() => undefined);
      this.logger.log(
        `merged PR #${job.pr_number} (${method}) for job ${jobId}, ruled by ${ruledBy}`,
      );
      return true;
    }
    if (result.reason === 'method_disallowed') {
      await this.postMethodDisallowedNoteOnce(job, method, result.message);
    } else {
      this.logger.warn(
        `auto-merge of PR #${job.pr_number} rejected (${result.reason} ${result.status}: ${result.message}) — no-op, relying on existing routing`,
      );
    }
    return false;
  }

  private methodDisallowedTs(jobId: string, method: AutoMergeMethod): string {
    return `automerge-method:${jobId}:${method}`;
  }

  private async hasMethodDisallowedNote(jobId: string, method: AutoMergeMethod): Promise<boolean> {
    const existing = await this.messages.findOne({
      where: { job_id: jobId, ts: this.methodDisallowedTs(jobId, method) },
    });
    return existing != null;
  }

  private async postMethodDisallowedNoteOnce(
    job: JobEntity,
    method: AutoMergeMethod,
    message: string,
  ): Promise<void> {
    const ts = this.methodDisallowedTs(job.id, method);
    const existing = await this.messages.findOne({
      where: { job_id: job.id, ts },
    });
    if (existing) return;
    if (!this.jobBootstrap) throw new Error('auto-merge: JobBootstrapService not wired');
    const threadId = await this.jobBootstrap.planningThreadId(job.id);
    await this.messages
      .save(
        this.messages.create({
          job_id: job.id,
          thread_id: threadId,
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: `Auto-merge is on, but GitHub rejected the "${method}" merge method for PR #${job.pr_number}: ${message}. Pick a different method, or merge manually.`,
          kind: 'build_event',
          ts,
        }),
      )
      .catch((err) =>
        this.logger.warn(`postMethodDisallowedNoteOnce failed for job ${job.id}: ${err}`),
      );
  }
}
