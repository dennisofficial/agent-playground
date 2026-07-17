import { Inject, Injectable } from '@nestjs/common';
import {
  JOB_TITLE_CHAIN,
  type JobTitleChainFactory,
  firstLineTitle,
  sanitizeTitle,
} from './job-title.chain';

@Injectable()
export class JobTitler {
  constructor(@Inject(JOB_TITLE_CHAIN) private readonly chainFor: JobTitleChainFactory) {}

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
