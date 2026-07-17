import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import {
  JOB_TITLE_CHAIN,
  type JobTitleChainFactory,
  sanitizeTitle,
} from '../titling/job-title.chain';
import { WebSurface } from './web-surface';

/**
 * Generates a concise title for a thread from its first message and applies it live. Runs fire-and-forget
 * off the thread-create path: the frontend's truncated first line seeds the row as an instant placeholder,
 * then this upgrades it to a real title (Haiku) and pushes a `thread_meta` SSE frame so the open UI flips
 * without a refresh. Fully defensive — every failure (no key, LLM error) degrades to keeping the
 * placeholder; it never throws into the caller.
 */
@Injectable()
export class JobTitleService {
  private readonly logger = new Logger(JobTitleService.name);

  constructor(
    @Inject(JOB_TITLE_CHAIN) private readonly chainFor: JobTitleChainFactory,
    private readonly surface: WebSurface,
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
  ) {}

  /** Generate a title from a message, or `undefined` when no Anthropic key resolves / the model errors. */
  async generate(input: { message: string; orgId?: string }): Promise<string | undefined> {
    const chain = await this.chainFor(input.orgId);
    if (!chain) return undefined;
    const raw = await chain.invoke({ message: input.message.slice(0, 4000) });
    return sanitizeTitle(raw);
  }

  /**
   * Generate + persist + broadcast. Compare-and-set on the placeholder so a fast manual rename (or a
   * deleted thread) is never clobbered, and the live frame fires ONLY when a row actually changed.
   */
  async generateAndApply(
    jobId: string,
    orgId: string,
    repoId: string,
    message: string,
    placeholder: string | null,
  ): Promise<void> {
    try {
      const title = await this.generate({ message, orgId });
      if (!title || title === placeholder) return;
      const res = await this.jobs.update(
        {
          id: jobId,
          org_id: orgId,
          title: placeholder === null ? IsNull() : placeholder,
        },
        { title },
      );
      if (res.affected) this.surface.emitThreadMeta(repoId, jobId, title);
    } catch (err) {
      this.logger.warn(`title generation failed for thread=${jobId}: ${err}`);
    }
  }
}
