import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EventSeverity } from '@shared/domain';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';

export interface AnnounceEventInput {
  orgId: string;
  repoId: string;
  jobId: string;
  source: string;
  severity: EventSeverity;
  title: string;
}

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  critical: ':rotating_light:',
  warning: ':warning:',
  info: ':information_source:',
};

@Injectable()
export class SurfaceOrchestration {
  private readonly logger = new Logger(SurfaceOrchestration.name);

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  async announceEvent(input: AnnounceEventInput): Promise<string | undefined> {
    const thread = await this.jobs.findOne({ where: { id: input.jobId } });
    if (!thread) return undefined;

    const headline = `${SEVERITY_EMOJI[input.severity]} *[${input.source}]* ${input.title}`;
    try {
      await this.surface.post(thread.repo_id, headline, {
        orgId: input.orgId,
        threadTs: thread.id,
      });
    } catch (err) {
      this.logger.warn(`announcement post failed (continuing): ${err}`);
      return undefined;
    }
    this.logger.log(`announced event thread ${input.jobId} on repo ${thread.repo_id}`);
    return thread.id;
  }
}
