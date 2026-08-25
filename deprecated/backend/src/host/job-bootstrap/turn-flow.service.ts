import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer, type FlowJob } from 'bullmq';
import { SandboxProvisionProcessor } from '../sandbox/sandbox-provision.processor';
import { WorkspaceProvisionProcessor } from '../workspace-fs/workspace-provision.processor';
import { TurnDispatchProcessor } from './turn-dispatch.processor';

@Injectable()
export class TurnFlowService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(@InjectFlowProducer() private readonly flowProducer: FlowProducer) {}

  async enqueue(jobId: string): Promise<void> {
    await this.flowProducer.add(this.build(jobId));
    this.logger.log(`enqueued turn flow for job ${jobId}`);
  }

  private build(jobId: string): FlowJob {
    // dispatch ← provision-pod ← prepare-workspace (children run before their parent). Workspace prep (host-side
    // clone + secrets) is its own step so it retries independently of pod bring-up.
    return {
      name: 'dispatch',
      queueName: TurnDispatchProcessor.name,
      data: { jobId },
      opts: { jobId: `dispatch-${jobId}`, removeOnComplete: true, removeOnFail: true },
      children: [
        {
          name: 'provision',
          queueName: SandboxProvisionProcessor.name,
          data: { jobId },
          opts: {
            jobId: `provision-${jobId}`,
            attempts: 2,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: true,
          },
          children: [
            {
              name: 'prepare-workspace',
              queueName: WorkspaceProvisionProcessor.name,
              data: { jobId },
              opts: {
                jobId: `prepare-workspace-${jobId}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: true,
                removeOnFail: true,
              },
            },
          ],
        },
      ],
    };
  }
}
