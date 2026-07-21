import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { TurnRunnerService } from './turn-runner.service';

type DispatchData = { jobId: string };

@Processor(TurnDispatchProcessor.name)
export class TurnDispatchProcessor extends BaseQueue {
  constructor(private readonly runner: TurnRunnerService) {
    super();
  }

  async process(job: Job<DispatchData>): Promise<void> {
    await this.runner.run(job.data.jobId);
  }
}
