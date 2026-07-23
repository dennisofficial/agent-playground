import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { EMessageAudience, EThreadMessageSource, EThreadOutputType } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadMessage } from '../../_lib/database/entities/thread-message.entity';

export type ProvisionStatus = 'preparing' | 'provisioning' | 'ready' | 'failed';

@Injectable()
export class ProvisionStatusService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(private readonly db: Db) {}

  async write(job: Job, status: ProvisionStatus, text: string): Promise<void> {
    const threadId = job.focusedThreadId;
    if (!threadId) return; // no planning thread to attach to yet — skip silently
    const tone = status === 'failed' ? 'error' : status === 'ready' ? 'success' : 'info';
    const meta = { event: 'sandbox', status, tone };
    try {
      const messages = this.db.unsafe(ThreadMessage);
      const existing = await messages
        .createQueryBuilder('m')
        .where('m.jobId = :jobId', { jobId: job.id })
        .andWhere("m.meta ->> 'event' = 'sandbox'")
        .getOne();
      if (existing) {
        await messages.update({ id: existing.id }, { text, meta });
      } else {
        await messages.save(
          messages.create({
            jobId: job.id,
            threadId,
            orgId: job.orgId,
            subagentId: null,
            source: EThreadMessageSource.SYSTEM,
            audience: EMessageAudience.OPERATOR_ONLY,
            type: EThreadOutputType.EVENT,
            authorId: 'system',
            text,
            card: null,
            meta,
            orderAt: null,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(`sandbox status pill write failed for job ${job.id}: ${String(err)}`);
    }
  }
}
