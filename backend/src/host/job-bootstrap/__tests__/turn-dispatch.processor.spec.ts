import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../../../_lib/database/entities/inbound-message.entity';
import type { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { TurnDispatcherService } from '../../turn/turn-dispatcher.service';
import { TurnDispatchProcessor } from '../turn-dispatch.processor';
import type { TurnFlowService } from '../turn-flow.service';

const msg = (id: string): InboundMessage => ({ id }) as InboundMessage;

// The dispatch logic now lives on the processor; drive it through process() with a fake BullMQ job.
const dispatch = (jobId: string) => ({ data: { jobId } }) as Job<{ jobId: string }>;

function makeProcessor(over: {
  claimPending: InboundMessageService['claimPending'];
  hasPending?: InboundMessageService['hasPending'];
  dispatch?: TurnDispatcherService['run'];
}) {
  const inbound = {
    claimPending: over.claimPending,
    markDelivered: vi.fn(async () => {}),
    hasPending: over.hasPending ?? vi.fn(async () => Promise.resolve(false)),
  } as unknown as InboundMessageService;
  const dispatcher = {
    run: over.dispatch ?? vi.fn(async () => {}),
  } as unknown as TurnDispatcherService;
  const turnFlow = { enqueue: vi.fn(async () => {}) } as unknown as TurnFlowService;
  const processor = new TurnDispatchProcessor(inbound, dispatcher, turnFlow);
  return { processor, inbound, dispatcher, turnFlow };
}

describe('TurnDispatchProcessor.process', () => {
  it('drains claimed messages and marks them DELIVERED on a successful dispatch', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValueOnce([msg('a'), msg('b')])
      .mockResolvedValueOnce([]);
    const { processor, inbound, turnFlow } = makeProcessor({ claimPending });

    await processor.process(dispatch('job-1'));

    expect(inbound.markDelivered).toHaveBeenCalledWith(['a', 'b']);
    expect(turnFlow.enqueue).not.toHaveBeenCalled(); // nothing new landed → no re-add
  });

  it('leaves rows PENDING (never delivered) and does not re-add when a dispatch throws', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValue([msg('a')]);
    const dispatchFn = vi.fn(async () => Promise.reject(new Error('sandbox not ready')));
    const hasPending = vi.fn(async () => Promise.resolve(true)); // rows are still pending after the failure
    const { processor, inbound, turnFlow } = makeProcessor({ claimPending, dispatch: dispatchFn, hasPending });

    await expect(processor.process(dispatch('job-1'))).rejects.toThrow('sandbox not ready');

    expect(inbound.markDelivered).not.toHaveBeenCalled();
    // On a thrown dispatch BullMQ retries the flow — the processor must NOT also re-add it.
    expect(turnFlow.enqueue).not.toHaveBeenCalled();
  });

  it('re-adds the flow in finally when new triggering work lands mid-run', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValueOnce([msg('a')])
      .mockResolvedValueOnce([]); // drained cleanly
    const hasPending = vi.fn(async () => Promise.resolve(true)); // ...but a new now/queued row arrived meanwhile
    const { processor, turnFlow } = makeProcessor({ claimPending, hasPending });

    await processor.process(dispatch('job-1'));

    expect(turnFlow.enqueue).toHaveBeenCalledTimes(1);
    expect(turnFlow.enqueue).toHaveBeenCalledWith('job-1');
  });
});
