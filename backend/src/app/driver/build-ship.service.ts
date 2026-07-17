import { Injectable, Logger } from '@nestjs/common';
import type { DecisionRecord, Job } from '@shared/domain';
import { BrainGateway } from '../brain-gateway/brain-gateway.service';
import { GithubPrService } from '../git/github-pr.service';
import { FeatureSandbox, LocalGitService } from '../git/local-git.service';
import { DriverStoreService } from './driver-store.service';
import type { ResolvedRepo } from './repo-resolver';

export type ShipOutcome =
  | { opened: true; prConfirmed: true; url: string; number: number }
  | { opened: true; prConfirmed: false }
  | { opened: false; reason: 'no-token' }
  | { opened: false; reason: 'leak-scan'; leaked: string[] };

export type PreShipResult =
  | { ok: true }
  | { ok: false; reason: 'no-token' }
  | { ok: false; reason: 'leak-scan'; leaked: string[] };

export type ShipRecord = Pick<DecisionRecord, 'overview' | 'decisions'>;

export interface ShipInput {
  job: Job;
  record: ShipRecord | null;
  repo: ResolvedRepo;
  sandbox: FeatureSandbox;
  notify?: (message: string) => Promise<void> | void;
}

@Injectable()
export class BuildShipService {
  private readonly logger = new Logger(BuildShipService.name);

  constructor(
    private readonly git: LocalGitService,
    private readonly pr: GithubPrService,
    private readonly store: DriverStoreService,
    private readonly brainGateway: BrainGateway,
  ) {}

  async ship(input: ShipInput): Promise<ShipOutcome> {
    const { job, repo, sandbox } = input;
    const notify = this.notifier(input.notify);

    const pre = await this.preShip(job, repo, sandbox, notify);
    if (!pre.ok) {
      return pre.reason === 'leak-scan'
        ? { opened: false, reason: 'leak-scan', leaked: pre.leaked }
        : { opened: false, reason: 'no-token' };
    }

    const observed = job.currentBranch ?? (await this.git.currentBranch(sandbox.worktreePath));
    const shipBranch = observed ?? sandbox.branch;
    if (observed && observed !== job.currentBranch) {
      await this.store.setCurrentBranch(job.id, observed);
    }
    const shipSandbox: FeatureSandbox = { ...sandbox, branch: shipBranch };
    const prTitle = job.title?.trim() || shipBranch;

    const ci = await this.store.ensureCiThread({
      jobId: job.id,
      orgId: job.orgId,
      decisionRecordId: job.decisionRecordId ?? null,
    });
    await this.brainGateway.openPrAtShip({
      jobId: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      branch: shipBranch,
      defaultBranch: repo.defaultBranch,
      title: prTitle,
      threadId: ci.threadId,
    });

    const confirmed = await this.latchPr(job, repo, shipSandbox);
    if (confirmed) {
      if (!job.prUrl) await notify(`:tada: PR ready: ${confirmed.url}`);
      return {
        opened: true,
        prConfirmed: true,
        url: confirmed.url,
        number: confirmed.number,
      };
    }
    return { opened: true, prConfirmed: false };
  }

  async preShip(
    job: Job,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
    notify?: (message: string) => Promise<void>,
  ): Promise<PreShipResult> {
    const relay = this.notifier(notify);

    if (!repo.token) {
      this.logger.warn(
        `job=${job.id}: no GitHub token — cannot push / open PR. Leaving as running.`,
      );
      await relay(':warning: Build complete but no GitHub token is configured — PR not opened.');
      return { ok: false, reason: 'no-token' };
    }

    let leaked: string[];
    try {
      leaked = await this.git.scanBranchForForbidden(
        sandbox.worktreePath,
        `origin/${repo.defaultBranch}`,
      );
    } catch (err) {
      this.logger.error(
        `job=${job.id}: pre-ship leak-scan FAILED (blocking ship, fail-closed): ${err}`,
      );
      await relay(
        ':no_entry: Pre-ship security scan could not complete — PR blocked. Check the branch and retry.',
      );
      return { ok: false, reason: 'leak-scan', leaked: [] };
    }
    if (leaked.length) {
      this.logger.error(
        `job=${job.id}: pre-ship leak-scan BLOCKED the PR — hydrated secret path(s) committed: ${leaked.join(', ')}`,
      );
      await relay(
        `:no_entry: PR blocked — a managed secret/seed file was committed on this branch: ` +
          `\`${leaked.join('`, `')}\`. These must never be committed. Remove them from history and retry.`,
      );
      return { ok: false, reason: 'leak-scan', leaked };
    }

    return { ok: true };
  }

  async latchPr(
    job: Job,
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<{ url: string; number: number } | undefined> {
    const confirmed = await this.discoverOpenPr(repo, sandbox);
    if (confirmed) {
      await this.store.ensureCiThread({
        jobId: job.id,
        orgId: job.orgId,
        decisionRecordId: job.decisionRecordId ?? null,
      });
      await this.store.setPrReady(job.id, confirmed.url, confirmed.number);
      return confirmed;
    }
    this.logger.warn(
      `job=${job.id}: ship could not confirm a PR url yet — leaving 'running' for the reconciler to latch`,
    );
    return undefined;
  }

  private notifier(
    notify?: (message: string) => Promise<void> | void,
  ): (m: string) => Promise<void> {
    return async (m: string) => {
      try {
        await notify?.(m);
      } catch (err) {
        this.logger.debug(`ship notify failed (continuing): ${err}`);
      }
    };
  }

  private async discoverOpenPr(
    repo: ResolvedRepo,
    sandbox: FeatureSandbox,
  ): Promise<{ url: string; number: number } | undefined> {
    if (!repo.token) return undefined;
    try {
      const found = await this.pr.findOpenPullByHead(repo.token, {
        owner: repo.owner,
        repo: repo.repo,
        head: sandbox.branch,
      });
      return found ?? undefined;
    } catch (err) {
      this.logger.debug(
        `ship: PR discovery by head failed for ${repo.owner}/${repo.repo}#${sandbox.branch}: ${err}`,
      );
      return undefined;
    }
  }
}
