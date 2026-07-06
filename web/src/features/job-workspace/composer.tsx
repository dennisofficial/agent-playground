"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import {
  useSay,
  useSayWithAttachments,
  useSendReviewComments,
  useStop,
} from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import { useAttachments } from "./use-attachments";
import { AttachmentTray } from "./attachment-tray";
import { MAIN_LANE, useLiveTurn } from "@/lib/api/job-stream";
import { useAllJobs } from "@/lib/api/inbox";
import { ContextMeter } from "./bubbles";
import { CommentTray } from "./comment-tray";
import { useReviewComments } from "./review-comments";
import { formatEffort, formatModelLabel } from "@/lib/format";

/** The lane's live footer data — the model/effort/engine that ran + its context occupancy. */
export interface ComposerFooter {
  model?: string;
  effort?: string;
  engine?: string;
  context?: { tokens: number; limit: number; model?: string } | null;
}

/**
 * The conversation composer — talks to the thread's brain. Posts to `…/jobs/:jobId/say`. Typed
 * ops ("pause", "approve", "resume", "simplify the rest"…) run the same operations as the buttons; the
 * brain interprets the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 *
 * Steering: a message sent WHILE a turn is live is injected into the running turn by the backend (the model
 * reacts mid-turn) — no code change here beyond dropping the old client queue. When a turn is live AND the
 * box is empty, the Send button becomes a STOP button (`…/jobs/:jobId/stop`) that gracefully ends the turn.
 *
 * The `＋` attach button is wired: it opens a file picker, and the operator can also PASTE images straight
 * into the textarea. Attachments preview in a tray (local blob URLs — no base64) and send as a multipart
 * `say`; the backend writes them to the sandbox and the brain reads them with its Read tool. The `Plan ▾`
 * mode pill remains a static design affordance for now. The model · effort label and the context ring ARE
 * live: they thread the lane's latest `turn_meta` (via the `footer` prop), so they change per lane.
 *
 * The composer renders on EVERY transcript lane. On non-Main lanes it is `readOnly`: the box is dimmed
 * and non-editable and the Send button is disabled (greyed), because the operator steers the brain from
 * the Main conversation, not a build/review lane — but the footer still shows that lane's model/effort/
 * occupancy.
 */
export function Composer({
  jobRef,
  placeholder = "Message Atlas — ask, plan, or steer…",
  onHeightChange,
  footer,
  readOnly = false,
}: {
  jobRef: JobRef;
  placeholder?: string;
  /** Reports the composer overlay's rendered height so the transcript can reserve matching space. */
  onHeightChange?: (height: number) => void;
  /** The lane's live footer data — model/effort/engine + context-window occupancy (latest turn). */
  footer?: ComposerFooter | null;
  /** Read-only lane (not Main): disable the input + Send, keep the footer live. */
  readOnly?: boolean;
}) {
  const say = useSay(jobRef);
  const sayWithAttachments = useSayWithAttachments(jobRef);
  const stop = useStop(jobRef);
  const sendReviewComments = useSendReviewComments(jobRef);
  const { comments, clearComments } = useReviewComments();
  const [text, setText] = useState("");
  const {
    attachments,
    error: attachError,
    add: addFiles,
    remove: removeAttachment,
    clear: clearAttachments,
    addPastedImages,
  } = useAttachments();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = ""; // allow re-picking the same file
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (readOnly) return;
    if (addPastedImages(e)) e.preventDefault();
  }

  // Is the brain's turn live? Same reconciliation the transcript uses: the SSE live turn, self-healed by the
  // authoritative realtime `needsYou` (idle = no turn), so a dropped `turn_end` doesn't strand a Stop button.
  // Read-only lanes never steer, so the Stop/live logic is irrelevant there (hooks stay unconditional).
  const liveActive = useLiveTurn(jobRef.jobId, MAIN_LANE)?.active ?? false;
  const { data: threads } = useAllJobs();
  const realtimeIdle =
    threads?.find((t) => t.id === jobRef.jobId)?.needsYou ?? false;
  const turnActive = !readOnly && liveActive && !realtimeIdle;
  // Stop replaces Send only when a turn is running AND the composer is empty (no pending text/comments to
  // send). With text present, the button is Send — which now STEERS the running turn server-side. Never on
  // a read-only lane.
  const showStop =
    turnActive &&
    !text.trim() &&
    comments.length === 0 &&
    attachments.length === 0;

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
    if (readOnly) return;
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
    if (attachments.length > 0) {
      // clear() empties the tray WITHOUT revoking — the optimistic attachments card still renders these blob
      // URLs; they're freed on composer unmount (the hook's createdUrlsRef backstop).
      sayWithAttachments.mutate({ text: trimmed, attachments });
      clearAttachments();
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

  const modelLabel = formatModelLabel(footer?.model, footer?.engine);
  const effortLabel = formatEffort(footer?.effort);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute bottom-0 left-0 right-2 px-6 pb-5 pt-[22px]"
      style={{
        background: "linear-gradient(to top, var(--panel) 58%, transparent)",
      }}
    >
      <div className="pointer-events-auto mx-auto max-w-[880px]">
        {readOnly ? null : <CommentTray />}
        <div
          className="rounded-2xl border border-border-2 bg-surface px-3 py-2.5"
          style={{
            boxShadow:
              "0 8px 30px rgba(20,18,12,.14), 0 2px 8px rgba(20,18,12,.06)",
          }}
        >
          {!readOnly ? (
            <AttachmentTray
              attachments={attachments}
              onRemove={removeAttachment}
              className="mb-2"
            />
          ) : null}
          {!readOnly && attachError ? (
            <div className="mb-2 text-[11px] text-red">{attachError}</div>
          ) : null}
          <div className={`flex items-start gap-2.5${readOnly ? " opacity-60" : ""}`}>
            <textarea
              ref={textareaRef}
              value={readOnly ? "" : text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              disabled={readOnly}
              placeholder={
                readOnly
                  ? "Read-only — steer Atlas from the Conversation"
                  : comments.length > 0
                    ? "Add a message with your comments (optional)…"
                    : placeholder
              }
              className="max-h-44 min-h-[24px] flex-1 resize-none overflow-y-auto bg-transparent pt-0.5 text-[13.5px] leading-relaxed text-text outline-none placeholder:text-faint disabled:cursor-default"
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
                  readOnly ||
                  (!text.trim() &&
                    comments.length === 0 &&
                    attachments.length === 0) ||
                  say.isPending ||
                  sayWithAttachments.isPending ||
                  sendReviewComments.isPending
                }
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-white transition hover:brightness-105 disabled:opacity-45"
                aria-label="Send"
                title={readOnly ? "Read-only lane" : undefined}
              >
                <ArrowUp size={15} strokeWidth={2.4} />
              </button>
            )}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            {/* Plan pill: static design affordance (not wired). The ＋ beside it IS wired (attach/paste). */}
            <span
              className={`flex items-center gap-1.5 rounded-lg border border-border-2 px-2.5 py-1 text-[12px] font-semibold text-text${readOnly ? " opacity-60" : ""}`}
            >
              Plan <ChevronDown size={11} strokeWidth={2.6} />
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={readOnly}
              className={`flex h-7 w-7 items-center justify-center rounded-lg text-dim transition hover:bg-surface-2 hover:text-text${readOnly ? " opacity-60" : ""}`}
              aria-label="Attach files"
              title="Attach files or images"
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.css,.js,.ts,.tsx"
              className="hidden"
              onChange={onPick}
            />
            <div className="flex-1" />
            {/* Live: the model · effort the lane's latest turn ran on (threads `turn_meta.usage`). */}
            {modelLabel ? (
              <span className="font-mono text-[11px] text-dim">
                {modelLabel}
                {effortLabel ? ` · ${effortLabel}` : ""}
              </span>
            ) : null}
            {footer?.context ? (
              <>
                <span className="h-3.5 w-px bg-border" />
                <ContextMeter
                  tokens={footer.context.tokens}
                  limit={footer.context.limit}
                  model={footer.context.model}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
