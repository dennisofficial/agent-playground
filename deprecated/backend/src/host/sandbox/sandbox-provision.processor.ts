import { Processor } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { TerminalPodError } from '../../_lib/k8s/k8s.service';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { SandboxService } from './sandbox.service';

type ProvisionData = { jobId: string };

/**
 * Queue entrypoint for pod bring-up. Stays a thin shell — unlike workspace prep, {@link SandboxService.ensureReady}
 * has a second in-process caller ({@link SandboxService.launchEngineTurn}), so the logic lives on the shared
 * service and this processor only owns the queue's retry policy.
 */
@Processor(SandboxProvisionProcessor.name)
export class SandboxProvisionProcessor extends BaseQueue {
  constructor(private readonly sandbox: SandboxService) {
    super();
  }

  async process(job: Job<ProvisionData>): Promise<void> {
    try {
      await this.sandbox.ensureReady(job.data.jobId);
    } catch (err) {
      if (err instanceof TerminalPodError || err instanceof NotFoundException) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }
}
