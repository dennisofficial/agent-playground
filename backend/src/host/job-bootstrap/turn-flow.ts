import type { FlowJob } from 'bullmq';
import { SandboxProvisionProcessor } from './sandbox-provision.processor';
import { TurnDispatchProcessor } from './turn-dispatch.processor';

export function buildTurnFlow(jobId: string): FlowJob {
  return {
    name: 'dispatch',
    queueName: TurnDispatchProcessor.name,
    data: { jobId },
    // BullMQ custom job ids must NOT contain ':' (its Redis key separator) — use '-'.
    opts: { jobId: `dispatch-${jobId}` },
    children: [
      {
        name: 'provision',
        queueName: SandboxProvisionProcessor.name,
        data: { jobId },
        opts: {
          jobId: `provision-${jobId}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 },
        },
      },
    ],
  };
}
