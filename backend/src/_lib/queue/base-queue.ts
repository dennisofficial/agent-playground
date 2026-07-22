import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

export abstract class BaseQueue extends WorkerHost {
  protected readonly logger = new Logger(this.constructor.name);

  protected constructor() {
    super();
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.log(`▶ ${BaseQueue.label(job)} (attempt ${job.attemptsMade + 1})`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`✔ ${BaseQueue.label(job)}`);
  }

  @OnWorkerEvent('failed')
  onError(job: Job | undefined, error: Error) {
    this.logger.error(`✖ ${BaseQueue.label(job)}: ${error.message}`, error.stack);
  }

  // A stalled parent that never leaves waiting-children is a classic silent-flow symptom, so surface it.
  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`⏱ stalled ${jobId}`);
  }

  private static label(job?: Job): string {
    const appJobId = (job?.data as { jobId?: string } | undefined)?.jobId;
    return `${job?.name ?? '?'}#${job?.id ?? '?'}${appJobId ? ` job=${appJobId}` : ''}`;
  }
}
