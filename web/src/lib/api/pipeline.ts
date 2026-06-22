'use client';

import { useMemo } from 'react';
import { useThreadMessages } from './messages';
import type { ApprovalDecision, ThreadStatus, WebOutboundMessage } from './types';

// ── Pipeline outline (DERIVED — `/web/pipeline` is unreachable; BACKEND_GAPS.md #3) ─────────────────
export interface PipelineOutlineSection {
  ordinal: number;
  brief: string;
  active: boolean;
}

export interface PipelineOutline {
  status: ThreadStatus;
  decisions: ApprovalDecision[];
  sections: PipelineOutlineSection[];
  prUrl?: string;
  /** Build events are streaming for this thread. */
  live: boolean;
  /** An open approval card is awaiting a verdict. */
  gated: boolean;
}

const PR_URL_RE = /https?:\/\/github\.com\/\S+\/pull\/\d+/i;

export function usePipelineOutline(channel: string | undefined, threadTs: string): PipelineOutline {
  const { messages } = useThreadMessages(channel, threadTs);

  return useMemo(() => {
    const approval = [...messages].reverse().find((m) => m.card?.type === 'approval_card');
    const verdict = messages.some((m) => m.card?.type === 'verdict_card');
    const buildEvents = messages.filter(
      (m) => (m.meta as { kind?: string } | undefined)?.kind === 'build_event',
    );
    const prMsg = messages.find((m) => PR_URL_RE.test(m.text));
    const prUrl = prMsg ? (prMsg.text.match(PR_URL_RE)?.[0] ?? undefined) : undefined;

    const card = approval?.card?.type === 'approval_card' ? approval.card : undefined;
    const briefs = card?.sections ?? [];
    const activeIndex = buildEvents.length > 0 ? Math.min(briefs.length - 1, lastSection(buildEvents)) : -1;

    const sections: PipelineOutlineSection[] = briefs.map((brief, i) => ({
      ordinal: i + 1,
      brief,
      active: i === activeIndex,
    }));

    let status: ThreadStatus = 'scoping';
    if (prUrl) status = 'done';
    else if (card && !verdict) status = 'awaiting_approval';
    else if (buildEvents.length > 0 || verdict) status = 'running';

    return {
      status,
      decisions: card?.decisions ?? [],
      sections,
      prUrl,
      live: buildEvents.length > 0 && !prUrl,
      gated: !!card && !verdict,
    };
  }, [messages]);
}

function lastSection(buildEvents: WebOutboundMessage[]): number {
  let max = 0;
  for (const e of buildEvents) {
    const ord = (e.meta as { sectionOrdinal?: number } | undefined)?.sectionOrdinal;
    if (typeof ord === 'number') max = Math.max(max, ord);
  }
  // sectionOrdinal may be gap-numbered (10,20,…) or 1-based; clamp to a zero-based index best-effort.
  return max >= 10 ? Math.floor(max / 10) - 1 : Math.max(0, max - 1);
}
