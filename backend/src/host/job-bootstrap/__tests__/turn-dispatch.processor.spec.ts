import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../../../_lib/database/entities/inbound-message.entity';
import type { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { TurnDispatcherService } from '../../turn/turn-dispatcher.service';
import { TurnDispatchProcessor } from '../turn-dispatch.processor';

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
    hasPending: over.hasPending ?? vi.fn(async () => Promise.resolve(false)),
  } as unknown as InboundMessageService;
  const dispatcher = {
    run: over.dispatch ?? vi.fn(async () => {}),
  } as unknown as TurnDispatcherService;
  const dispatchQueue = { add: vi.fn(async () => ({})) } as unknown as Queue;
  const processor = new TurnDispatchProcessor(inbound, dispatcher, dispatchQueue);
  return { processor, inbound, dispatcher, dispatchQueue };
}

describe('TurnDispatchProcessor.process', () => {
  it('drains claimed messages by dispatching each batch (run() handles consumption, not the processor)', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValueOnce([msg('a'), msg('b')])
      .mockResolvedValueOnce([]);
    const { processor, dispatcher, dispatchQueue } = makeProcessor({ claimPending });

    await processor.process(dispatch('job-1'));

    expect(dispatcher.run).toHaveBeenCalledWith('job-1', [msg('a'), msg('b')]);
    // run() writes each bubble + flips the row to CONSUMED as the SDK incorporates it — the processor itself
    // performs no status transitions.
    expect(dispatchQueue.add).not.toHaveBeenCalled(); // nothing new landed → no re-add
  });

  it('leaves rows PENDING (never delivered) and does not re-add when a dispatch throws', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValue([msg('a')]);
    const dispatchFn = vi.fn(async () => Promise.reject(new Error('sandbox not ready')));
    const hasPending = vi.fn(async () => Promise.resolve(true)); // rows are still pending after the failure
    const { processor, dispatchQueue } = makeProcessor({
      claimPending,
      dispatch: dispatchFn,
      hasPending,
    });

    await expect(processor.process(dispatch('job-1'))).rejects.toThrow('sandbox not ready');

    // On a thrown dispatch BullMQ retries the flow — the processor must NOT also re-add it.
    expect(dispatchQueue.add).not.toHaveBeenCalled();
  });

  it('re-dispatches via its own queue when new triggering work lands mid-run', async () => {
    const claimPending = vi
      .fn<InboundMessageService['claimPending']>()
      .mockResolvedValueOnce([msg('a')])
      .mockResolvedValueOnce([]); // drained cleanly
    const hasPending = vi.fn(async () => Promise.resolve(true)); // ...but a new now/queued row arrived meanwhile
    const { processor, dispatchQueue } = makeProcessor({ claimPending, hasPending });

    await processor.process(dispatch('job-1'));

    expect(dispatchQueue.add).toHaveBeenCalledTimes(1);
    expect(dispatchQueue.add).toHaveBeenCalledWith('dispatch', { jobId: 'job-1' });
  });
});
