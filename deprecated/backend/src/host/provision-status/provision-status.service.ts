import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { EMessageAudience, EThreadMessageSource, EThreadOutputType } from '@workspace/shared';
import type { JobModel } from '../../generated/prisma/models';

export type ProvisionStatus = 'preparing' | 'provisioning' | 'ready' | 'failed';

@Injectable()
export class ProvisionStatusService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(private readonly prismaService: PrismaService) {}

  async write(job: JobModel, status: ProvisionStatus, text: string): Promise<void> {
    const threadId = job.focusedThreadId;
    if (!threadId) return; // no planning thread to attach to yet — skip silently
    const tone = status === 'failed' ? 'error' : status === 'ready' ? 'success' : 'info';
    const meta = { event: 'sandbox', status, tone };
    try {
      const existing = await this.prismaService.threadMessage.findFirst({
        where: { jobId: job.id, meta: { path: ['event'], equals: 'sandbox' } },
      });
      if (existing) {
        await this.prismaService.threadMessage.update({
          where: { id: existing.id },
          data: { text, meta },
        });
      } else {
        await this.prismaService.threadMessage.create({
          data: {
            jobId: job.id,
            threadId,
            orgId: job.orgId,
            subagentId: null,
            source: EThreadMessageSource.SYSTEM,
            audience: EMessageAudience.OPERATOR_ONLY,
            type: EThreadOutputType.EVENT,
            authorId: 'system',
            text,
            card: undefined,
            meta,
            orderAt: null,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`sandbox status pill write failed for job ${job.id}: ${String(err)}`);
    }
  }
}
