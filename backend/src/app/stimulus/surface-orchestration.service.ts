import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EventSeverity } from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { CHAT_SURFACE, type ChatSurface } from '../surface';

/** Inputs to announce a freshly-seeded notification thread in the channel timeline. */
export interface AnnounceEventInput {
  orgId: string;
  repoId: string;
  /** The `threads` row id the event seeded. */
  threadId: string;
  /** The gateway that produced the event (for the headline). */
  source: string;
  severity: EventSeverity;
  /** The short human-readable title derived by intake (the first line of the body). */
  title: string;
}

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  critical: ':rotating_light:',
  warning: ':warning:',
  info: ':information_source:',
};

/**
 * SURFACE ORCHESTRATION — posts a notification's timeline headline into its (already-seeded) thread.
 * Threads carry a real id, so the headline posts directly into the thread (`threadTs = thread.id`) with
 * no `surface_thread_ref` backfill or channel lookup. Best-effort: a surface that can't post leaves the
 * thread quiet rather than failing.
 */
@Injectable()
export class SurfaceOrchestration {
  private readonly logger = new Logger(SurfaceOrchestration.name);

  constructor(
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly threads: Repository<JobEntity>,
  ) {}

  /**
   * Post the timeline headline for a seeded event thread, into the thread itself. Returns the thread id
   * (the conversation handle) or undefined when nothing was posted (surface inert / thread missing).
   */
  async announceEvent(input: AnnounceEventInput): Promise<string | undefined> {
    const thread = await this.threads.findOne({ where: { id: input.threadId } });
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
    this.logger.log(`announced event thread ${input.threadId} on repo ${thread.repo_id}`);
    return thread.id;
  }
}
