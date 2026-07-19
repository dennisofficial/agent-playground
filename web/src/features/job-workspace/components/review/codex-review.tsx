'use client';

import type { JobMessage } from '@/lib/api/job-api';
import { useLiveTurn } from '@/lib/api/job-stream';
import { ShieldCheck } from 'lucide-react';
import { Markdown } from '../conversation/markdown';
import { durableSubBlocks, type SubBlock } from '../../subagents';

/**
 * The Codex PLAN REVIEW is a dialogue that rides the shared transcript spine on a `codex-review:<jobId>`
 * lane and tags every durable block with `meta.codexReviewId = jobId`. Like a build phase, that full stream
 * (Codex's reasoning + file reads/commands + findings) is peeled OUT of the main conversation into its own
 * lane sub-page; what stays in Main is a compact {@link CodexReviewCard} per delivered round — the same
 * `source:'system_shared'` findings summary, now clickable — carrying `meta.codexReviewAnchor = true`.
 *
 * One lane per job collapses ALL rounds (submit_plan re-reviews + respond_to_review replies) into one
 * coherent back-and-forth, since they resume the same Codex session.
 */

/** The node key that opens the Codex review lane in the detail pane (`?node=`). */
export const CODEX_REVIEW_PREFIX = 'codex-review:';
export const codexReviewNode = (jobId: string): string => `${CODEX_REVIEW_PREFIX}${jobId}`;
/** The live-stream lane the review dialogue streams on (matches the backend `codexReviewLane`). */
export const codexReviewLane = (jobId: string): string => `codex-review:${jobId}`;

export interface CodexReviewIndex {
  /** `message.ts` of every block produced by the review stream (hide these in the main conversation log). */
  childKeys: Set<string>;
  /** `message.ts` of every delivered findings-summary row (render these as a card, not a plain bubble). */
  anchorKeys: Set<string>;
}

/** Peel the Codex review stream out of the main conversation + mark the per-round summary anchors. */
export function indexCodexReviewBlocks(messages: JobMessage[]): CodexReviewIndex {
  const childKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  for (const m of messages) {
    const cid = typeof m.meta?.codexReviewId === 'string' ? (m.meta.codexReviewId as string) : null;
    if (!cid) continue;
    if (m.meta?.codexReviewAnchor === true) {
      anchorKeys.add(m.ts);
      continue;
    }
    childKeys.add(m.ts);
  }
  return { childKeys, anchorKeys };
}

/** The review lane's durable transcript blocks — the stream rows (anchors excluded), mapped to SubBlock. */
export function durableCodexBlocks(messages: JobMessage[]): SubBlock[] {
  return durableSubBlocks(
    messages.filter(
      (m) => typeof m.meta?.codexReviewId === 'string' && m.meta?.codexReviewAnchor !== true,
    ),
  );
}

/**
 * The compact card that stands in for one delivered Codex review round in the MAIN conversation. It shows
 * the round's findings summary (the same body Atlas reacts to) and opens the full review lane — Codex's
 * reasoning, the files it read, and Atlas's rebuttals across every round. Pulses while a round is running.
 */
export function CodexReviewCard({
  jobId,
  message,
  onOpen,
}: {
  jobId: string;
  message: JobMessage;
  onOpen: () => void;
}) {
  const live = useLiveTurn(jobId, codexReviewLane(jobId));
  const running = live?.active ?? false;
  const round =
    typeof message.meta?.reviewRound === 'number' ? (message.meta.reviewRound as number) : null;
  const findings =
    typeof message.meta?.findingsCount === 'number' ? (message.meta.findingsCount as number) : null;

  return (
    <div
      className="anim-fadeUp my-px rounded-[10px] border"
      style={{
        borderColor: running ? 'var(--accent-line)' : 'var(--border)',
        background: running
          ? 'var(--accent-soft)'
          : 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
      }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span
          className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{
            background: 'linear-gradient(145deg, var(--slate), var(--slate))',
          }}
          aria-hidden
        >
          <ShieldCheck size={13} color="#fff" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-text">Codex review</span>
            {round != null ? (
              <span className="rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-widest text-faint">
                round {round}
              </span>
            ) : null}
            {findings != null ? (
              <span className="font-mono text-[9.5px] uppercase tracking-widest text-faint">
                {findings === 0 ? 'no findings' : `${findings} finding${findings === 1 ? '' : 's'}`}
              </span>
            ) : null}
            {running ? (
              <span className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-widest text-faint">
                <span
                  className="pulse-dot h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
                reviewing
              </span>
            ) : null}
          </div>
          {message.text ? (
            <div className="mt-1 text-[12px] leading-relaxed text-dim [&_p]:my-0 [&_p]:text-[12px] [&_p]:leading-relaxed [&_p]:text-dim">
              <Markdown>{message.text}</Markdown>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-accent transition hover:bg-surface-3"
          style={{
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-line)',
          }}
        >
          Open transcript →
        </button>
      </div>
    </div>
  );
}
