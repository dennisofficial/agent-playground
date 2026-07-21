import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

export abstract class BaseQueue extends WorkerHost {
  protected readonly logger = new Logger(this.constructor.name);

  protected constructor() {
    super();
  }

  @OnWorkerEvent('failed')
  onError(job: Job | undefined, error: Error) {
    this.logger.error(`Job Failed: ${job?.name}`, error.stack);
  }
}
