import { Inject, Injectable, Logger } from '@nestjs/common';
import { CHAT_SURFACE, type ChatSurface } from '../surface';
import type { DecisionClassification } from './decision-gate.types';

/** A section's plan to surface for human visibility. */
export interface SectionPlanPost {
  /** Surface-native channel coordinate. */
  channel: string;
  /** The thread the plan is posted into (the job's thread). Omit to post top-level. */
  threadTs?: string;
  /** The tenant to post as (selects the workspace bot token). */
  teamId?: string;
  /** A short section title ("Backend — persistence layer"). */
  title: string;
  /** The detailed plan prose / phase list. */
  plan: string;
  /**
   * The never-ask / covered decisions made WHILE planning this section — surfaced here so the human can
   * see (and override) the autonomous calls without being blocked on them. ASK-class decisions never
   * reach here; they go through park-and-ask instead.
   */
  decisions?: DecisionClassification[];
}

/**
 * W5 — VISIBILITY posting. Posts a section's detailed plan into the job thread for human visibility.
 * NON-BLOCKING and never gates: the section proceeds whether or not anyone reads it; the human may
 * override anytime, but the post itself doesn't wait on a reply. This is the "its detailed plan is
 * still posted for visibility (override anytime, but it doesn't block)" half of model C — the park-and-
 * ask service is the OTHER half (the only thing that blocks). Zero v1 imports.
 */
@Injectable()
export class PlanVisibilityService {
  private readonly logger = new Logger(PlanVisibilityService.name);

  constructor(@Inject(CHAT_SURFACE) private readonly surface: ChatSurface) {}

  /**
   * Post the section plan into its thread. Returns the posted message's ts (or undefined if no surface
   * is bound / the post failed) — fire-and-forget-friendly: callers need not await beyond the post.
   */
  async postSectionPlan(post: SectionPlanPost): Promise<string | undefined> {
    const text = renderSectionPlan(post);
    try {
      return await this.surface.post(post.channel, text, {
        ...(post.threadTs ? { threadTs: post.threadTs } : {}),
        ...(post.teamId ? { teamId: post.teamId } : {}),
      });
    } catch (err) {
      // Visibility must never break the pipeline — log and move on.
      this.logger.warn(
        `failed to post section plan "${post.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}

/** Render the section plan as a plain-text Slack post (mrkdwn). Pure — unit-testable. */
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
