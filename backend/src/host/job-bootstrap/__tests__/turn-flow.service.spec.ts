import type { FlowJob, FlowProducer } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { TurnFlowService } from '../turn-flow.service';

describe('TurnFlowService.enqueue', () => {
  it('adds a flow with deterministic single-flight job ids for the parent + children', async () => {
    const add = vi.fn(async (_flow: FlowJob) => Promise.resolve({}));
    const service = new TurnFlowService({ add } as unknown as FlowProducer);

    await service.enqueue('job-9');

    const flow = add.mock.calls[0][0];
    expect(flow.opts?.jobId).toBe('dispatch-job-9');
    expect(flow.children?.[0].opts?.jobId).toBe('provision-job-9');
    // Provision fails fast (low attempts) rather than hammering the sandbox.
    expect(flow.children?.[0].opts?.attempts).toBe(2);
    // Host-side workspace prep is a grandchild so it retries independently of pod bring-up.
    expect(flow.children?.[0].children?.[0].opts?.jobId).toBe('prepare-workspace-job-9');
  });
});
