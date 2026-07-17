"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import {
  useJobMessages,
  useMessage,
  useSendReviewComments,
  useStop,
} from "@/lib/api/job-queries";
import {
  ThreadApiError,
  type MessageInput,
  type JobRef,
} from "@/lib/api/job-api";
import type { PendingAttachment } from "@/lib/api/job-queries";
import { useConnectivity } from "@/lib/api/connectivity";
import {
  composerStore,
  useComposerDraft,
  useComposerStagedAnswers,
  type StagedAnswer,
} from "@/lib/api/composer-store";
import type { AttachmentsApi } from "./use-attachments";
import { AttachmentTray } from "./attachment-tray";
import { MAIN_LANE, useLiveTurn, type ContextBreakdown } from "@/lib/api/job-stream";
import { useAllJobs } from "@/lib/api/inbox";
import { ContextMeter } from "./bubbles";
import { UsageRing } from "./usage-ring";
import { CommentTray } from "./comment-tray";
import { QueuedTray } from "./queued-tray";
import { StagedAnswersTray } from "./staged-answers-tray";
import { useReviewComments, type ReviewComment } from "./review-comments";
import { formatEffort, formatModelLabel } from "@/lib/format";

/** Map one staged answer to the wire shape `/message` expects (drops the chip-only `label`). */
function toMessageItem(a: StagedAnswer): MessageInput {
  if (a.kind === "question") {
    return { type: "answer_question", questionId: a.cardId, answer: a.answer };
  }
  if (a.kind === "file") {
    return {
      type: "file_answered",
      requestId: a.cardId,
      filename: a.filename,
      content: a.content,
    };
  }
  return { type: "secret_provided", requestId: a.cardId, value: a.value };
}

/** The lane's live footer data — the model/effort/engine that ran + its context occupancy. */
export interface ComposerFooter {
  model?: string;
  effort?: string;
  engine?: string;
  context?: {
    tokens: number;
    limit: number;
    model?: string;
    contextBreakdown?: ContextBreakdown | null;
  } | null;
}

/**
 * The conversation composer — talks to the thread's brain. Posts to `…/jobs/:jobId/message`. Typed
 * ops ("pause", "approve", "resume", "simplify the rest"…) run the same operations as the buttons; the
 * brain interprets the text, so the composer just sends it. Enter sends; Shift+Enter newlines.
 *
 * Steering: a message sent WHILE a turn is live is injected into the running turn by the backend (the model
 * reacts mid-turn) — no code change here beyond dropping the old client queue. When a turn is live AND the
 * box is empty, the Send button becomes a STOP button (`…/jobs/:jobId/stop`) that gracefully ends the turn.
 *
 * The `＋` attach button is wired: it opens a file picker, and the operator can also PASTE images straight
 * into the textarea OR drag-and-drop files anywhere onto the conversation pane (the drop target lives in
 * {@link TranscriptView}, which owns the attachment tray and passes it in via `attach`). Attachments preview
 * in a tray (local blob URLs — no base64) and send as a multipart `/message`; the backend writes them to the
 * sandbox and the brain reads them with its Read tool. The `Plan ▾`
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
  attach,
  lane,
  threadId,
  placeholder = "Message Atlas — ask, plan, or steer…",
  onHeightChange,
  footer,
  readOnly = false,
  blocked = false,
  variant = "composer",
}: {
  jobRef: JobRef;
  /** The attachment tray API, owned by {@link TranscriptView} so a pane-wide file drop feeds the same tray.
   *  Optional: the `subagent` variant has no input/attach, so callers there omit it. */
  attach?: AttachmentsApi;
  /** The lane this composer posts to — omitted (undefined) for Main, where the backend defaults to Main.
   *  On an operator-writable non-Main lane (a builder/master_review thread) this routes the send to that
   *  thread instead of Main. */
  lane?: string;
  /** The real thread id this lane's durable transcript is scoped to (mirrors {@link TranscriptView}'s
   *  `threadId`) — stamped onto the optimistic message so it matches the transcript's `threadId` filter
   *  instead of being scoped out until the send settles. Omitted for a pre-plan (`no_job`) Main, where the
   *  log is unfiltered anyway. */
  threadId?: string;
  placeholder?: string;
  /** Reports the composer overlay's rendered height so the transcript can reserve matching space. */
  onHeightChange?: (height: number) => void;
  /** The lane's live footer data — model/effort/engine + context-window occupancy (latest turn). */
  footer?: ComposerFooter | null;
  /** Read-only lane (not Main): disable the input + Send, keep the footer live. */
  readOnly?: boolean;
  /** The job is `blocked` on another job: fully disable the composer (a send would just 400) and swap the
   *  placeholder — the operator unblocks from the conversation-pane overlay above. Same inert treatment as
   *  `readOnly`, different copy. */
  blocked?: boolean;
  /**
   * `"composer"` (default) — the full interactive/read-only composer (input row + footer). `"subagent"` —
   * a FOOTER-ONLY bar for a subagent's read-only detail pane: no input, no Send/attach; the left shows a
   * static "read-only sub-agent" label instead of the Plan pill + ＋, the right keeps model + context ring.
   */
  variant?: "composer" | "subagent";
}) {
  // Footer-only mode for a subagent's read-only detail pane (no input/attach/send).
  const isSubagent = variant === "subagent";
  // A blocked job's composer is inert for the same reasons a read-only lane's is: no input, no Send, no
  // attach/paste — the only difference is the placeholder copy (and that the operator unblocks above).
  const inert = readOnly || blocked;
  const message = useMessage(jobRef);
  const stop = useStop(jobRef);
  const sendReviewComments = useSendReviewComments(jobRef);
  const stagedAnswers = useComposerStagedAnswers(jobRef);
  const { comments, clearComments } = useReviewComments();
  const connectivity = useConnectivity();
  // Hygiene: drop any staged answer whose card has gone stale (withdrawn, or already answered/provided by
  // another tab) since it was staged, so the tray can never submit a dead card.
  const { data: messages } = useJobMessages(jobRef);
  useEffect(() => {
    if (!messages) return;
    composerStore.pruneStagedAnswers(jobRef, messages);
  }, [jobRef.jobId, messages]);
  // Per-Job draft text — held in the external store (not local state) so it survives Job-switch and reload
  // instead of bleeding between Jobs. Read-only/subagent lanes force value "" and never call setText.
  const text = useComposerDraft(jobRef).text;
  const setText = (t: string) => composerStore.setText(jobRef, t);
  // `attach` is absent in the subagent variant. Default `attachments` to `[]` so the pre-return computations
  // (showStop, button-disabled) stay safe; the fn refs are only invoked from input handlers that don't render.
  const {
    attachments = [],
    error: attachError,
    add: addFiles,
    remove: removeAttachment,
    clear: clearAttachments,
    addPastedImages,
  } = attach ?? ({} as Partial<AttachmentsApi>);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles?.(Array.from(e.target.files));
    e.target.value = ""; // allow re-picking the same file
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (inert) return;
    if (addPastedImages?.(e)) e.preventDefault();
  }

  // Is the brain's turn live? Same reconciliation the transcript uses: the SSE live turn, self-healed by the
  // authoritative realtime `needsYou` (idle = no turn), so a dropped `turn_end` doesn't strand a Stop button.
  // Read-only lanes never steer, so the Stop/live logic is irrelevant there (hooks stay unconditional).
  const liveActive = useLiveTurn(jobRef.jobId, MAIN_LANE)?.active ?? false;
  const { data: threads } = useAllJobs();
  const realtimeIdle =
    threads?.find((t) => t.id === jobRef.jobId)?.needsYou ?? false;
  const turnActive = !inert && liveActive && !realtimeIdle;
  // Stop replaces Send only when a turn is running AND the composer is empty (no pending text/comments to
  // send). With text present, the button is Send — which now STEERS the running turn server-side. Never on
  // a read-only lane.
  const showStop =
    turnActive &&
    !text.trim() &&
    comments.length === 0 &&
    attachments.length === 0 &&
    stagedAnswers.length === 0;

  // Auto-grow the textarea to fit its content (capped by the CSS max-height, which then scrolls).
  // Reset to `auto` first so the box can also shrink as lines are removed.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // The tree does not remount on Job switch, so flush the outgoing Job's debounced sessionStorage write
  // immediately. The store's pagehide listener covers reloads that happen inside the debounce window.
  useLayoutEffect(() => {
    return () => composerStore.flushDraft(jobRef.jobId);
  }, [jobRef.jobId]);

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
    if (inert) return;
    const trimmed = text.trim();

    // Offline: don't attempt the POST at all — move the message into the per-Job outbox and clear the
    // composer so the operator can keep composing. The <OutboxFlusher> drains it FIFO on reconnect.
    const offline = connectivity !== "online";
    if (offline) {
      if (
        comments.length === 0 &&
        attachments.length === 0 &&
        stagedAnswers.length === 0 &&
        !trimmed
      )
        return;
      // Staged answers have no outbox support (the offline `QueuedMessage` has no `items` field, and
      // enqueueing one would silently send an empty message) — leave the tray + typed note untouched so
      // the operator can retry Send once back online.
      if (stagedAnswers.length > 0) return;
      // The flusher drains each queued item with mutually-exclusive precedence (comments → attachments →
      // text): a single item carrying BOTH comments and attachments would only send its comments and
      // silently drop the attachments. So when comments are present, enqueue any attachments as their OWN
      // outbox message (text rides with the comments) so both are delivered on reconnect.
      const now = Date.now();
      composerStore.enqueue(jobRef, {
        id: crypto.randomUUID(),
        createdAt: now,
        text: trimmed,
        comments,
        attachments: comments.length > 0 ? [] : attachments,
      });
      if (comments.length > 0 && attachments.length > 0) {
        composerStore.enqueue(jobRef, {
          id: crypto.randomUUID(),
          createdAt: now + 1, // orders after the comments item in the FIFO drain
          text: "",
          comments: [],
          attachments,
        });
      }
      // Drop the chips/tray WITHOUT revoking blob URLs — the queued chip still previews them (see
      // use-attachments' clear()). Only the draft TEXT is cleared here, not the whole draft, so
      // clearDraft's outbox-preserving re-persist isn't needed on this path.
      clearComments();
      clearAttachments?.();
      composerStore.setText(jobRef, "");
      return;
    }

    // Mid-flight fallback: an ONLINE send's mutation can still hit a network drop between the status
    // check above and the POST landing. Most `ThreadApiError`s mean the server actually answered (a real
    // 4xx/5xx), so leave them to the mutation's own error handling. The backend's leader-handoff 503 is
    // explicitly transient ("retry momentarily"), so preserve it in the outbox instead of losing the cleared
    // composer draft.
    const reEnqueueOnNetworkError = (
      e: Error,
      fields: {
        text: string;
        comments: ReviewComment[];
        attachments: PendingAttachment[];
      },
    ): boolean => {
      if (e instanceof ThreadApiError && e.status !== 503) return false;
      composerStore.enqueue(jobRef, {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...fields,
      });
      return true;
    };

    if (comments.length > 0) {
      sendReviewComments.mutate(
        {
          items: comments.map((c) => ({
            file: c.file.label,
            quote: c.quote,
            note: c.note || undefined,
            ...(c.lines ? { lines: c.lines } : {}),
          })),
          message: trimmed || undefined,
          threadId,
        },
        {
          onError: (e) => {
            const queued = reEnqueueOnNetworkError(e, {
              text: trimmed,
              comments,
              attachments: [],
            });
            if (queued) return;
            composerStore.setText(jobRef, trimmed);
            composerStore.setComments(jobRef, () => comments);
          },
        },
      );
      clearComments();
      composerStore.clearDraft(jobRef.jobId);
      return;
    }

    const hasText = trimmed.length > 0;
    const hasAttachments = attachments.length > 0;
    // Exclude entries still `submitting` from a prior send that hasn't been confirmed by the refetch yet
    // (pruneStagedAnswers only drops them once threadMessages reconfirms the card) — otherwise a second
    // Send before that round-trip lands would resend their already-submitted payload.
    const unsubmittedStagedAnswers = stagedAnswers.filter((a) => !a.submitting);
    const hasStaged = unsubmittedStagedAnswers.length > 0;
    if (hasStaged || hasText || hasAttachments) {
      // Eager clear: the composer text and staged tray clear the instant Send is hit, so the lifecycle
      // renders through a server-driven "sending" state (the message/card themselves) rather than sitting
      // in the composer until the mutation settles. A failed send restores both below.
      const stagedSnapshot = unsubmittedStagedAnswers;
      const stagedIds = stagedSnapshot.map((a) => a.cardId);
      const items: MessageInput[] = [
        ...stagedSnapshot.map(toMessageItem),
        ...(hasText || hasAttachments
          ? [
              {
                type: "user" as const,
                text: trimmed,
                ...(lane ? { lane } : {}),
              },
            ]
          : []),
      ];
      composerStore.setText(jobRef, "");
      if (hasStaged) composerStore.markSubmitting(jobRef, stagedIds, true);
      message.mutate(
        { messages: items, attachments, threadId },
        {
          onError: (e) => {
            const queued = hasStaged
              ? false
              : reEnqueueOnNetworkError(e, {
                  text: trimmed,
                  comments: [],
                  attachments,
                });
            if (!queued) {
              composerStore.setText(jobRef, trimmed);
              if (hasAttachments) {
                composerStore.setAttachments(jobRef, () => attachments);
              }
            }
            if (hasStaged)
              composerStore.markSubmitting(jobRef, stagedIds, false);
          },
        },
      );
      // clear() empties the tray WITHOUT revoking — the optimistic attachments card still renders these blob
      // URLs; they're freed when the tab closes.
      if (hasAttachments) clearAttachments?.();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const modelLabel = formatModelLabel(footer?.model, footer?.engine);
  const effortLabel = formatEffort(footer?.effort);
  // Sustained mid-session outage: glow the Composer red so the operator sees the box is still theirs
  // (the message is preserved) while the connectivity store keeps reconnecting. Display-only — typing
  // and Send stay enabled (offline SEND behavior is handled separately).
  const showOffline = connectivity === "offline" && !readOnly && !isSubagent;

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute bottom-0 left-0 right-2 px-6 pb-5 pt-[22px]"
      style={{
        background: "linear-gradient(to top, var(--panel) 58%, transparent)",
      }}
    >
      <div className="pointer-events-auto mx-auto max-w-[880px]">
        {inert || isSubagent ? null : (
          <>
            <QueuedTray jobRef={jobRef} />
            <StagedAnswersTray jobRef={jobRef} />
            <CommentTray />
          </>
        )}
        {!inert && !isSubagent && message.isError ? (
          <div className="mb-2 text-[11px] text-red">
            Could not send — try again.
          </div>
        ) : null}
        <div
          className="rounded-2xl border border-border-2 bg-surface px-3 py-2.5"
          style={{
            boxShadow: showOffline
              ? "0 8px 30px rgba(20,18,12,.14), 0 2px 8px rgba(20,18,12,.06), 0 0 0 1.5px var(--red-line), 0 0 18px color-mix(in srgb, var(--red) 22%, transparent)"
              : "0 8px 30px rgba(20,18,12,.14), 0 2px 8px rgba(20,18,12,.06)",
          }}
        >
          {!inert && !isSubagent ? (
            <AttachmentTray
              attachments={attachments}
              onRemove={removeAttachment ?? (() => {})}
              className="mb-2"
            />
          ) : null}
          {!inert && !isSubagent && attachError ? (
            <div className="mb-2 text-[11px] text-red">{attachError}</div>
          ) : null}
          {isSubagent ? null : (
            <div
              className={`flex items-start gap-2.5${inert ? " opacity-60" : ""}`}
            >
              <textarea
                ref={textareaRef}
                value={inert ? "" : text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                rows={1}
                disabled={inert}
                placeholder={
                  blocked
                    ? "This job is blocked — unblock it above to continue"
                    : readOnly
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
                    inert ||
                    (!text.trim() &&
                      comments.length === 0 &&
                      attachments.length === 0 &&
                      stagedAnswers.filter((a) => !a.submitting).length ===
                        0) ||
                    message.isPending ||
                    sendReviewComments.isPending
                  }
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent text-white transition hover:brightness-105 disabled:opacity-45"
                  aria-label="Send"
                  title={
                    blocked
                      ? "This job is blocked"
                      : readOnly
                        ? "Read-only lane"
                        : undefined
                  }
                >
                  <ArrowUp size={15} strokeWidth={2.4} />
                </button>
              )}
            </div>
          )}

          <div
            className={`${isSubagent ? "" : "mt-2.5 "}flex items-center gap-2`}
          >
            {isSubagent ? (
              // Subagent read-only pane: a static label where the Plan pill + ＋ normally sit.
              <span className="font-mono text-[11px] text-faint">
                read-only sub-agent
              </span>
            ) : (
              <>
                {/* Plan pill: static design affordance (not wired). The ＋ beside it IS wired (attach/paste). */}
                <span
                  className={`flex items-center gap-1.5 rounded-lg border border-border-2 px-2.5 py-1 text-[12px] font-semibold text-text${inert ? " opacity-60" : ""}`}
                >
                  Plan <ChevronDown size={11} strokeWidth={2.6} />
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={inert}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg text-dim transition hover:bg-surface-2 hover:text-text${inert ? " opacity-60" : ""}`}
                  aria-label="Attach files"
                  title="Attach files or images"
                >
                  <Plus size={16} strokeWidth={2.2} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml,.html,.htm,.css,.js,.ts,.tsx,.zip"
                  className="hidden"
                  onChange={onPick}
                />
              </>
            )}
            {showOffline ? (
              <span
                className="font-mono text-[11px]"
                style={{ color: "var(--red)" }}
              >
                reconnecting…
              </span>
            ) : null}
            <div className="flex-1" />
            {!isSubagent && jobRef.orgId ? (
              <UsageRing orgId={jobRef.orgId} />
            ) : null}
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
                  breakdown={footer.context.contextBreakdown}
                />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
