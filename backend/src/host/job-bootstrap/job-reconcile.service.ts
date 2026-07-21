import { EnvService } from '@core/config/env/env.service';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FlowProducer } from 'bullmq';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { buildTurnFlow } from './turn-flow';

/**
 * Safety net for the one step of job creation that can't be transactional: the BullMQ flow enqueue lives in
 * Redis, so a crash (or Redis blip) between the create() commit and the flow-add can leave a durable job with
 * a PENDING inbound message but no flow. This sweep re-enqueues a flow for every such job.
 *
 * Idempotent by construction: {@link buildTurnFlow} uses deterministic job ids, so re-adding a flow that's
 * still in-flight is a no-op, and once a turn is dispatched the inbound messages flip to DELIVERED and drop
 * out of the scan. The normal create() path still enqueues inline — this only closes the failure window.
 */
@Injectable()
export class JobReconcileService {
  private readonly logger = new Logger(this.constructor.name);
  private readonly isTestDb: boolean;

  constructor(
    private readonly inbound: InboundMessageService,
    @InjectFlowProducer() private readonly flowProducer: FlowProducer,
    env: EnvService,
  ) {
    this.isTestDb = /_test$/.test(env.get('POSTGRES_DB'));
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    if (this.isTestDb) return;

    let jobIds: string[];
    try {
      jobIds = await this.inbound.pendingJobIds();
    } catch (err) {
      this.logger.warn(`reconcile scan failed: ${String(err)}`);
      return;
    }
    for (const jobId of jobIds) {
      try {
        await this.flowProducer.add(buildTurnFlow(jobId));
      } catch (err) {
        this.logger.warn(`reconcile re-enqueue failed for job ${jobId}: ${String(err)}`);
      }
    }
  }
}
