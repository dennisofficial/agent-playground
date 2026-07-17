import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { PrStateDelta } from '../../_shared/domain';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { DriverStoreService } from './driver-store.service';
import { JobLifecycleService } from './job-lifecycle.service';

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
      return this.onPrOpened(delta.orgId, delta.repoId, delta.headRef, delta.url, delta.prNumber);
    }
    if (delta.action === 'reopened') {
      return this.onPrReopened(delta.orgId, delta.repoId, delta.prNumber);
    }
    return this.onPrClosed(delta.orgId, delta.repoId, delta.prNumber, delta.merged);
  }

  async onPrOpened(
    orgId: string,
    repoId: string,
    headRef: string,
    url: string,
    number: number,
  ): Promise<void> {
    const job = await this.stimStore.findOwningJobByBranch(orgId, repoId, headRef);
    if (!job) {
      this.logger.debug(
        `pr #${number} opened — no owning job for branch "${headRef}" in ${repoId} (ignored)`,
      );
      return;
    }
    if (job.pr_number == null) {
      await this.driverStore.ensureCiThread({
        jobId: job.id,
        orgId: job.org_id,
        decisionRecordId: job.decision_record_id ?? null,
      });
      await this.driverStore.setPrReady(job.id, url, number);
    }
  }

  async onPrClosed(orgId: string, repoId: string, number: number, merged: boolean): Promise<void> {
    const job = await this.stimStore.findOwningJobByPrNumber(orgId, repoId, number);
    if (!job) {
      this.logger.debug(
        `pr #${number} ${merged ? 'merged' : 'closed'} — no owning job in ${repoId} (ignored)`,
      );
      return;
    }
    await this.lifecycle.applyGithubPrState(job, merged ? 'merged' : 'closed');
  }

  async onPrReopened(orgId: string, repoId: string, number: number): Promise<void> {
    const job = await this.stimStore.findOwningJobByPrNumber(orgId, repoId, number);
    if (!job) {
      this.logger.debug(`pr #${number} reopened — no owning job in ${repoId} (ignored)`);
      return;
    }
    await this.jobs.update({ id: job.id }, { pr_state: 'open' });
  }
}
