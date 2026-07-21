import { InjectFlowProducer, Processor } from '@nestjs/bullmq';
import { FlowProducer, Job } from 'bullmq';
import { BaseQueue } from '../../_lib/queue/base-queue';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { TurnDispatcherService } from '../turn/turn-dispatcher.service';
import { buildTurnFlow } from './turn-flow';
import { TurnSpecBuilder } from './turn-spec-builder.service';

type DispatchData = { jobId: string };

@Processor(TurnDispatchProcessor.name)
export class TurnDispatchProcessor extends BaseQueue {
  constructor(
    private readonly inbound: InboundMessageService,
    private readonly turnDispatcher: TurnDispatcherService,
    private readonly specBuilder: TurnSpecBuilder,
    @InjectFlowProducer() private readonly flowProducer: FlowProducer,
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
          break;
        }
        const spec = await this.specBuilder.build(jobId, claimed);
        await this.turnDispatcher.run(jobId, claimed[0].threadId, spec);
        await this.inbound.markDelivered(claimed.map((m) => m.id));
      }
    } finally {
      // Only chase mid-run arrivals when we exited cleanly. On a thrown dispatch we let the BullMQ job
      // fail and retry the flow itself — re-adding here would double up with that retry.
      if (drained && (await this.inbound.hasPending(jobId))) {
        await this.flowProducer.add(buildTurnFlow(jobId));
      }
    }
  }
}
