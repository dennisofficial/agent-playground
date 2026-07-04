"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import { useSay, useSendReviewComments, useStop } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import { MAIN_LANE, useLiveTurn } from "@/lib/api/job-stream";
import { useAllJobs } from "@/lib/api/inbox";
import { ContextMeter } from "./bubbles";
import { CommentTray } from "./comment-tray";
import { useReviewComments } from "./review-comments";

/**
 * The conversation composer — talks to the thread's brain. Posts to `…/jobs/:jobId/say`. Typed
 * ops ("pause", "approve", "resume", "simplify the rest"…) run the same operations as the buttons; the
 * brain interprets the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 *
 * Steering: a message sent WHILE a turn is live is injected into the running turn by the backend (the model
 * reacts mid-turn) — no code change here beyond dropping the old client queue. When a turn is live AND the
 * box is empty, the Send button becomes a STOP button (`…/jobs/:jobId/stop`) that gracefully ends the turn.
 *
 * The `Plan ▾` mode pill, the `＋` attach button, and the model label are visual affordances from the
 * design and are intentionally static for now (no backend wiring) — see `web/BACKEND_GAPS.md`.
 */
export function Composer({
  jobRef,
  placeholder = "Message Atlas — ask, plan, or steer…",
  onHeightChange,
  context,
}: {
  jobRef: JobRef;
  placeholder?: string;
  /** Reports the composer overlay's rendered height so the transcript can reserve matching space. */
  onHeightChange?: (height: number) => void;
  /** The thread's context-window occupancy (latest turn) — rendered as the bottom-right ring, Claude-Code style. */
  context?: { tokens: number; limit: number; model?: string } | null;
}) {
  const say = useSay(jobRef);
  const stop = useStop(jobRef);
  const sendReviewComments = useSendReviewComments(jobRef);
  const { comments, clearComments } = useReviewComments();
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Is the brain's turn live? Same reconciliation the transcript uses: the SSE live turn, self-healed by the
  // authoritative realtime `needsYou` (idle = no turn), so a dropped `turn_end` doesn't strand a Stop button.
  const liveActive = useLiveTurn(jobRef.jobId, MAIN_LANE)?.active ?? false;
  const { data: threads } = useAllJobs();
  const realtimeIdle =
    threads?.find((t) => t.id === jobRef.jobId)?.needsYou ?? false;
  const turnActive = liveActive && !realtimeIdle;
  // Stop replaces Send only when a turn is running AND the composer is empty (no pending text/comments to
  // send). With text present, the button is Send — which now STEERS the running turn server-side.
  const showStop = turnActive && !text.trim() && comments.length === 0;

  // Auto-grow the textarea to fit its content (capped by the CSS max-height, which then scrolls).
  // Reset to `auto` first so the box can also shrink as lines are removed.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Measure the overlay so the transcript spacer threads it as the box grows/shrinks.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeightChange) return;
    const report = () => onHeightChange(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeightChange]);

  function send() {
    const trimmed = text.trim();
    if (comments.length > 0) {
      sendReviewComments.mutate({
        items: comments.map((c) => ({
          file: c.file.label,
          quote: c.quote,
          note: c.note || undefined,
        })),
        message: trimmed || undefined,
      });
      clearComments();
      setText("");
      return;
    }
    if (!trimmed) return;
    say.mutate(trimmed);
    setText("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute bottom-0 left-0 right-2 px-6 pb-5 pt-[22px]"
      style={{
        background: "linear-gradient(to top, var(--panel) 58%, transparent)",
      }}
    >
      <div className="pointer-events-auto mx-auto max-w-[880px]">
        <CommentTray />
        <div
          className="rounded-2xl border border-border-2 bg-surface px-3 py-2.5"
          style={{
            boxShadow:
              "0 8px 30px rgba(20,18,12,.14), 0 2px 8px rgba(20,18,12,.06)",
          }}
        >
          <div className="flex items-start gap-2.5">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={
                comments.length > 0
                  ? "Add a message with your comments (optional)…"
                  : placeholder
              }
              className="max-h-44 min-h-[24px] flex-1 resize-none overflow-y-auto bg-transparent pt-0.5 text-[13.5px] leading-relaxed text-text outline-none placeholder:text-faint"
            />
            {showStop ? (
              <button
                type="button"
                onClick={() => stop.mutate()}
                disabled={stop.isPending}
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-white transition hover:brightness-105 disabled:opacity-45"
                aria-label="Stop"
                title="Stop Atlas"
              >
                <Square size={12} strokeWidth={2.6} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={
                  (!text.trim() && comments.length === 0) ||
                  say.isPending ||
                  sendReviewComments.isPending
                }
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-white transition hover:brightness-105 disabled:opacity-45"
                aria-label="Send"
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
            )}
          </div>

          {/* Static affordances (design parity — not wired yet) */}
          <div className="mt-2.5 flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-lg border border-border-2 px-2.5 py-1 text-[12px] font-semibold text-text">
              Plan <ChevronDown size={11} strokeWidth={2.6} />
            </span>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg text-dim">
              <Plus size={16} strokeWidth={2.2} />
            </span>
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-dim">
              Opus 4.8 · Fast
            </span>
            {context ? (
              <>
                <span className="h-3.5 w-px bg-border" />
                <ContextMeter
                  tokens={context.tokens}
                  limit={context.limit}
                  model={context.model}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
