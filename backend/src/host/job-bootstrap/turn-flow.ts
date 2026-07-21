import type { FlowJob } from 'bullmq';
import { SandboxProvisionProcessor } from '../sandbox/sandbox-provision.processor';
import { WorkspaceProvisionProcessor } from '../workspace-fs/workspace-provision.processor';
import { TurnDispatchProcessor } from './turn-dispatch.processor';

export function buildTurnFlow(jobId: string): FlowJob {
  // dispatch ← provision-pod ← prepare-workspace (children run before their parent). Workspace prep (host-side
  // clone + secrets) is its own step so it retries independently of pod bring-up.
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
        children: [
          {
            name: 'prepare-workspace',
            queueName: WorkspaceProvisionProcessor.name,
            data: { jobId },
            opts: {
              jobId: `prepare-workspace-${jobId}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 1000 },
            },
          },
        ],
      },
    ],
  };
}
