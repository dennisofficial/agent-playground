import { Inject, Injectable, Logger } from '@nestjs/common';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import type { DecisionClassification } from './decision-gate.types';

export interface SectionPlanPost {
  channel: string;
  threadTs?: string;
  orgId?: string;
  title: string;
  plan: string;
  decisions?: DecisionClassification[];
}

@Injectable()
export class PlanVisibilityService {
  private readonly logger = new Logger(PlanVisibilityService.name);

  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {}

  async postSectionPlan(post: SectionPlanPost): Promise<string | undefined> {
    const text = renderSectionPlan(post);
    try {
      return await this.surface.post(post.channel, text, {
        ...(post.threadTs ? { threadTs: post.threadTs } : {}),
        ...(post.orgId ? { orgId: post.orgId } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `failed to post thread plan "${post.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}

export function renderSectionPlan(post: SectionPlanPost): string {
  const lines: string[] = [`:clipboard: *Plan — ${post.title}*`, '', post.plan.trim()];
  const surfaced = (post.decisions ?? []).filter((d) => d.verdict !== 'ask');
  if (surfaced.length > 0) {
    lines.push('', '*Decisions made autonomously* (override anytime):');
    for (const d of surfaced) {
      const tag = d.verdict === 'covered' ? 'covered' : 'proceeding';
      const cite = d.coveredBy ? ` — per "${d.coveredBy}"` : '';
      lines.push(`• _(${tag})_ ${d.reason}${cite}`);
    }
  }
  return lines.join('\n');
}
