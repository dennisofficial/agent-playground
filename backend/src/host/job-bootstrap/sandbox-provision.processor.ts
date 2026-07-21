import { Processor } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { SandboxRuntime } from '../sandbox/sandbox-runtime.service';

type ProvisionData = { jobId: string };

@Processor(SandboxProvisionProcessor.name)
export class SandboxProvisionProcessor extends BaseQueue {
  constructor(private readonly sandbox: SandboxRuntime) {
    super();
  }

  async process(job: Job<ProvisionData>): Promise<void> {
    await this.sandbox.ensureReady(job.data.jobId);
  }
}
