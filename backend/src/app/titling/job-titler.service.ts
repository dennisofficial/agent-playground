import { Inject, Injectable } from '@nestjs/common';
import {
  JOB_TITLE_CHAIN,
  type JobTitleChainFactory,
  firstLineTitle,
  sanitizeTitle,
} from './job-title.chain';

/**
 * The single, shared way to turn ANY source text (a thread's first message, a plan goal, a build summary,
 * an event headline) into a short, scannable thread title via the title model. Lives in
 * the `@Global` titling module so every write path — the web surface, the brain store, the brain session,
 * the event intake — produces ONE consistent title style instead of dumping raw
 * full-sentence text into `threads.title`.
 *
 * Fully fail-soft: no per-org key, an LLM error, or empty model output all degrade to the deterministic
 * {@link firstLineTitle} fallback. `titleFor` ALWAYS returns a usable string, so callers can write it
 * directly with no null-handling.
 */
@Injectable()
export class JobTitler {
  constructor(
    @Inject(JOB_TITLE_CHAIN) private readonly chainFor: JobTitleChainFactory,
  ) {}

  /** Short display title for a thread from any source text. Never throws; never returns empty. */
  async titleFor(text: string, orgId?: string): Promise<string> {
    const fallback = firstLineTitle(text);
    try {
      const chain = await this.chainFor(orgId);
      if (!chain) return fallback;
      const raw = await chain.invoke({ message: text.slice(0, 4000) });
      return sanitizeTitle(raw) ?? fallback;
    } catch {
      return fallback;
    }
  }
}
