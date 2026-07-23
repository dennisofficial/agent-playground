import { InjectQueue, Processor } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { TurnDispatcherService } from '../turn/turn-dispatcher.service';

type DispatchData = { jobId: string };

@Processor(TurnDispatchProcessor.name)
export class TurnDispatchProcessor extends BaseQueue {
  constructor(
    private readonly inbound: InboundMessageService,
    private readonly turnDispatcher: TurnDispatcherService,
    @InjectQueue(TurnDispatchProcessor.name) private readonly dispatchQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<DispatchData>): Promise<void> {
    await this.run(job.data.jobId);
  }

  private async run(jobId: string): Promise<void> {
    let drained = false;
    try {
      for (;;) {
        const claimed = await this.inbound.claimPending(jobId);
        if (claimed.length === 0) {
          drained = true;
          this.logger.log(`job ${jobId}: no pending trigger messages, dispatch drained`);
          break;
        }
        this.logger.log(`job ${jobId}: dispatching ${claimed.length} message(s)`);
        // run() consumes the batch as the SDK's turn incorporates each message (writes the bubble + flips the row
        // to CONSUMED), with a turn-end backstop — so nothing here marks delivery.
        await this.turnDispatcher.run(jobId, claimed);
      }
    } finally {
      // Only chase mid-run arrivals when we exited cleanly. On a thrown dispatch we let the BullMQ job
      // fail and retry the flow itself — re-adding here would double up with that retry.
      if (drained && (await this.inbound.hasPending(jobId))) {
        this.logger.log(`job ${jobId}: work arrived mid-run, re-dispatching`);
        await this.dispatchQueue.add('dispatch', { jobId });
      }
    }
  }
}
