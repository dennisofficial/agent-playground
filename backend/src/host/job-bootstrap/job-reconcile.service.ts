import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { TurnFlowService } from './turn-flow.service';

@Injectable()
export class JobReconcileService {
  private readonly logger = new Logger(this.constructor.name);
  private readonly isTestDb: boolean;

  constructor(
    private readonly inbound: InboundMessageService,
    private readonly turnFlow: TurnFlowService,
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
    if (jobIds.length > 0) {
      this.logger.log(`reconcile: ${jobIds.length} job(s) with pending work, re-enqueuing`);
    }
    for (const jobId of jobIds) {
      try {
        await this.turnFlow.enqueue(jobId);
      } catch (err) {
        this.logger.warn(`reconcile re-enqueue failed for job ${jobId}: ${String(err)}`);
      }
    }
  }
}
