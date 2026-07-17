import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { PrStateDelta } from '@shared/domain';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { StimulusStoreService } from '../stimulus';
import { DriverStoreService } from './driver-store.service';
import { JobLifecycleService } from './job-lifecycle.service';

/**
 * The SILENT GitHub `pull_request` webhook sync — the fast path that mirrors `pollPrClosures`'
 * apply-logic (via `JobLifecycleService.applyGithubPrState`) so the two can't drift. It writes the
 * owning job's DB columns directly (`pr_url`/`pr_number`/`pr_state`) and NEVER goes through
 * `StimulusIntake` — it doesn't wake a brain, doesn't seed a job, and never appears on the sidebar as
 * an event. The 30-min poll remains the backstop for deliveries the webhook missed (downtime, replay).
 */
@Injectable()
export class GithubPrStateSync {
  private readonly logger = new Logger(GithubPrStateSync.name);

  constructor(
    private readonly lifecycle: JobLifecycleService,
    private readonly driverStore: DriverStoreService,
    private readonly stimStore: StimulusStoreService,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  async dispatch(delta: PrStateDelta): Promise<void> {
    if (delta.action === 'opened') {
      return this.onPrOpened(
        delta.orgId,
        delta.repoId,
        delta.headRef,
        delta.url,
        delta.prNumber,
      );
    }
    if (delta.action === 'reopened') {
      return this.onPrReopened(delta.orgId, delta.repoId, delta.prNumber);
    }
    return this.onPrClosed(
      delta.orgId,
      delta.repoId,
      delta.prNumber,
      delta.merged,
    );
  }

  /** A PR opened for a job's branch — record it (idempotent: a job that already has a pr_number is left alone). */
  async onPrOpened(
    orgId: string,
    repoId: string,
    headRef: string,
    url: string,
    number: number,
  ): Promise<void> {
    const job = await this.stimStore.findOwningJobByBranch(
      orgId,
      repoId,
      headRef,
    );
    if (!job) {
      this.logger.debug(
        `pr #${number} opened — no owning job for branch "${headRef}" in ${repoId} (ignored)`,
      );
      return;
    }
    if (job.pr_number == null) {
      // Post-ship seam (d14): mirror build-ship's ensureShipThread — the webhook fast path is a second route
      // to "PR recorded", so it must ensure the ship thread group thread exists too, not just the driver's own latchPr.
      // Create it before publishing `done`, so observers never see a PR-ready job without its ship lane.
      await this.driverStore.ensureShipThread({
        jobId: job.id,
        orgId: job.org_id,
        decisionRecordId: job.decision_record_id ?? null,
      });
      await this.driverStore.setPrReady(job.id, url, number);
    }
  }

  /** A PR merged or closed-without-merge — apply the terminal state via the shared apply-logic. */
  async onPrClosed(
    orgId: string,
    repoId: string,
    number: number,
    merged: boolean,
  ): Promise<void> {
    const job = await this.stimStore.findOwningJobByPrNumber(
      orgId,
      repoId,
      number,
    );
    if (!job) {
      this.logger.debug(
        `pr #${number} ${merged ? 'merged' : 'closed'} — no owning job in ${repoId} (ignored)`,
      );
      return;
    }
    await this.lifecycle.applyGithubPrState(job, merged ? 'merged' : 'closed');
  }

  /** A previously-closed PR reopened — flip `pr_state` back to `open`; the job's `status` stays `done`. */
  async onPrReopened(
    orgId: string,
    repoId: string,
    number: number,
  ): Promise<void> {
    const job = await this.stimStore.findOwningJobByPrNumber(
      orgId,
      repoId,
      number,
    );
    if (!job) {
      this.logger.debug(
        `pr #${number} reopened — no owning job in ${repoId} (ignored)`,
      );
      return;
    }
    await this.jobs.update({ id: job.id }, { pr_state: 'open' });
  }
}
