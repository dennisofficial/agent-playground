"use client";

import { useMemo, useRef, useState } from "react";
import { HelpCircle, Upload } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { classifyMessage } from "./classify";
import { liveTurnVisibleForLeg } from "./live-turn-visibility";
import { JumpToLatestButton, useTailFollow } from "./tail-follow";
import {
  buildLiveTurnItems,
  ClaudeBubble,
  CompactionSummaryPill,
  EventBubble,
  HarnessBubble,
  LiveIndicator,
  SystemEventPill,
  SystemNoticeRow,
  UntrustedBlock,
  SystemOperatorNotice,
  SystemReminderChip,
  ThinkingBlock,
  TurnMetaDivider,
  UserBubble,
} from "./bubbles";
import { ToolGroup, segmentToolRun, type ToolItem } from "./tool-calls";
import { ApprovalCardView, VerdictCardView } from "./approval-card";
import { QuestionCardView } from "./question-card";
import { SecretCardView } from "./secret-card";
import { McpProposalCard } from "./mcp-proposal-card";
import { SkillProposalCard } from "./skill-proposal-card";
import { TicketCardView } from "./ticket-card";
import { FileCardView } from "./file-card";
import { ReviewCommentsCardView } from "./review-comments-card";
import { AttachmentsCardView } from "./attachments-card";
import { SubagentCard, indexDurableSubagents, subagentNode } from "./subagents";
import {
  AgentPromptBlock,
  BuildInstruction,
  BuildStepCard,
  indexPhaseBlocks,
} from "./phases";
import {
  CodexReviewCard,
  codexReviewNode,
  indexCodexReviewBlocks,
} from "./codex-review";
import { indexAutofixBlocks } from "./review-lane";
import { Composer, type ComposerFooter } from "./composer";
import { useAttachments } from "./use-attachments";
import { useFileDrop } from "./use-file-drop";
import { DetailTopBar } from "./detail-top-bar";
import type { JobMessage, JobRef } from "@/lib/api/job-api";
import type { LaneDefaultFooter } from "@/lib/api/types";
import { MAIN_LANE, useLiveTurn } from "@/lib/api/job-stream";
import { useAllJobs } from "@/lib/api/inbox";

/**
 * Conversation mode — the Main lane (the thread's brain). Just the shared {@link TranscriptView} with the
 * composer turned on: intent, planning, and steering all live here. Every OTHER lane (Codex review, a build
 * thread/step) renders the IDENTICAL TranscriptView without a composer — one renderer, no divergence.
 */
export function Conversation({
  jobRef,
  messages,
  isLoading,
  live,
  mainDefaultFooter,
  onOpenPlan,
  onSelectNode,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  isLoading: boolean;
  live: boolean;
  /** The Main (brain) lane's pre-turn footer default ("Opus 4.8") — shown before the first brain turn. */
  mainDefaultFooter?: LaneDefaultFooter;
  onOpenPlan?: () => void;
  /** Open a node in the right detail pane (e.g. a subagent run's sub-page). */
  onSelectNode?: (node: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <ConversationTopBar />
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={MAIN_LANE}
        composer
        isLoading={isLoading}
        live={live}
        defaultFooter={mainDefaultFooter}
        onOpenPlan={onOpenPlan}
        onSelectNode={onSelectNode}
      />
    </div>
  );
}

/**
 * THE ONE transcript renderer — every lane (Main, Codex review, a build thread/step) renders through this
 * so they look and behave identically: the same typed bubbles, tool-call groups, thinking blocks,
 * subagent/phase cards, token dividers, live streaming, tail-follow, and windowing. The ONLY per-lane
 * differences are (a) which blocks feed it — `buildLogItems(log, { lane })` scopes membership + peeling —
 * (b) which live lane it subscribes to (`useLiveTurn(jobId, lane)`), and (c) whether it shows a composer.
 * It renders the scrolling body only; the caller supplies the surrounding shell (top bar / pane).
 */
export function TranscriptView({
  jobRef,
  messages,
  lane = MAIN_LANE,
  phaseIds,
  legOrdinal,
  legIsLive,
  composer = false,
  readOnly = false,
  isLoading = false,
  live = false,
  emptyText,
  defaultFooter,
  onOpenPlan,
  onSelectNode,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  /** Which lane's transcript this renders — `'main'` | `codex-review:<jobId>` | `thread:<threadId>`. */
  lane?: string;
  /** For a build THREAD lane: the phase anchor ids to aggregate (the `lane` still picks the live turn). */
  phaseIds?: Set<string>;
  /** For a per-LEG view of a build thread: show only rows tagged `meta.legOrdinal === this` (untagged = Leg 1).
   *  Each rotated session is its own navigable node; the Leg's handoff + continuation-seed rows ride this tag. */
  legOrdinal?: number;
  /** For a per-LEG view: whether THIS Leg is the active (live) one. The in-flight turn is subscribed on
   *  the thread's stable lane — shared by every Leg — so only the live Leg may render the live tail +
   *  spinner; a rotated Leg passes `false` to suppress it. Ignored for non-Leg lanes (legOrdinal unset). */
  legIsLive?: boolean;
  /** Show the composer. On Main it's interactive; on every other lane pass `readOnly` alongside. */
  composer?: boolean;
  /** Read-only lane (not Main): the composer's input + Send are disabled, but its footer stays live. */
  readOnly?: boolean;
  isLoading?: boolean;
  live?: boolean;
  /** The empty-state line when the lane has no activity yet. */
  emptyText?: string;
  /** The lane's backend-supplied `model · effort` default — shown in the footer BEFORE the lane's first turn
   *  completes (no `turn_meta` yet). A real `turn_meta` always wins over it. */
  defaultFooter?: LaneDefaultFooter;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
}) {
  // The composer is a floating overlay; thread its height so the transcript reserves matching space and
  // the last line never slips under it as the box auto-grows. Read-only lanes just reserve a small pad.
  const [composerHeight, setComposerHeight] = useState(116);
  const bottomPad = composer ? composerHeight : 20;

  // The attachment tray is owned HERE (not inside the composer) so a file dropped anywhere on the pane feeds
  // the same tray the ＋ button and paste do. Drop is live only on the interactive Main composer — read-only
  // lanes and lanes without a composer ignore drags entirely.
  const attach = useAttachments();
  const acceptsDrop = composer && !readOnly;
  const { isDragging, dropHandlers } = useFileDrop(attach.add, acceptsDrop);

  // A brief ring flash on the question card we just jumped to, so it's easy to spot after the scroll lands.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cursor for cycling the pinned "awaiting you" chip through multiple open questions on repeated clicks.
  const cycleRef = useRef(0);

  const liveTurn = useLiveTurn(jobRef.jobId, lane);
  const liveBlockCount = liveTurn?.blocks.length ?? 0;

  // The in-flight turn is shared across every Leg of a thread (one lane). A rotated Leg's pane must NOT
  // render it — only the live Leg (or a non-Leg lane) may show the live tail, spinner, and context ring.
  const liveAllowed = liveTurnVisibleForLeg(legOrdinal, legIsLive);

  // The AUTHORITATIVE turn signal: the server-owned realtime `needsYou` (true = the AI is idle / awaiting
  // you — a turn is NOT running). If it flips true while a stale live turn still lingers (a dropped
  // `turn_end`), we treat the turn as OVER so the "working…" indicator self-heals OFF. Only the Main lane
  // cross-checks this — the realtime feed is job-level, so it can't gate independent build (phase) lanes,
  // and a read-only lane (composer on, but not Main) must NOT cross-check it either.
  const realtimeIdle = useRealtimeIdle(composer && !readOnly ? jobRef.jobId : null);
  const turnActive = (liveTurn?.active ?? false) && !realtimeIdle;

  // Stream signature — grows with streaming text/thinking so the tail follows token-by-token, not just on
  // block boundaries.
  const liveStreamSig = (liveTurn?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === "tool" ? 1 : b.text.length),
    0,
  );

  // Steering is server-side now: a message sent mid-turn is injected into the running turn by the backend
  // (no client queue) — a message posted mid-turn shows up in `messages` before the turn ends. So the
  // durable log (below the live turn) and the live turn itself would render it TWICE — once here, once
  // wherever it lands in `log` — unless we split it out and time-merge it into the LIVE window instead (see
  // `trailing` below). Fallback (no live turn / startedAt unknown): behave exactly as today, one flat log.
  const startedAt = liveTurn?.startedAt;
  const liveWindowActive = !!liveTurn?.active && startedAt != null && liveAllowed;
  const midTurnRows = useMemo(
    () =>
      liveWindowActive
        ? messages.filter((m) => messagePostedMs(m) >= startedAt!)
        : [],
    [messages, liveWindowActive, startedAt],
  );
  const log = useMemo(
    () =>
      liveWindowActive
        ? messages.filter((m) => messagePostedMs(m) < startedAt!)
        : messages,
    [messages, liveWindowActive, startedAt],
  );

  // A turn-failure "Resume" card is only actionable while the thread is STILL halted (the failure is
  // outstanding). `halted` is a single live bit, so the outstanding failure is always the MOST-RECENT
  // retryable card; once the thread resumes it flips false and every past failure card shows a muted
  // "Resumed" instead of a live CTA that could be pressed again by mistake. Unknown (realtime row not
  // cached yet) keeps the button, so we never hide a genuinely-needed Resume.
  const openThreadHalted = useThreadHalted(jobRef.jobId);
  const outstandingRetryTs = useMemo<string | null>(() => {
    if (openThreadHalted === false) return null;
    let ts: string | null = null;
    for (const m of messages) {
      if (m.source === "system_operator" && m.meta?.retryable === true) ts = m.ts;
    }
    return ts;
  }, [messages, openThreadHalted]);

  // The composer footer — model · effort (from the latest `turn_meta`, else the lane's config default) + the
  // context ring. Computed for every lane that shows a composer (Main + read-only), scoped to the lane. The
  // ring prefers a LIVE occupancy value (`liveTurn.contextTokens`, streamed mid-turn by the engine's `usage`
  // event) while the turn is running, so a multi-minute turn's ring fills as it goes instead of only jumping
  // at turn end; it falls back to the durable `turn_meta` occupancy between turns.
  const footer = useMemo(() => {
    if (!composer) return null;
    const base = laneFooterMeta(messages, lane, phaseIds, legOrdinal) ?? defaultFooterAsComposer(defaultFooter);
    const liveContext =
      turnActive && liveAllowed && typeof liveTurn?.contextTokens === "number" && liveTurn.contextLimit
        ? {
            tokens: liveTurn.contextTokens,
            limit: liveTurn.contextLimit,
            model: liveTurn.contextModel,
          }
        : null;
    if (!liveContext) return base;
    return { ...(base ?? {}), context: liveContext };
  }, [
    composer,
    messages,
    lane,
    phaseIds,
    defaultFooter,
    turnActive,
    liveAllowed,
    liveTurn?.contextTokens,
    liveTurn?.contextLimit,
    liveTurn?.contextModel,
  ]);

  // The durable transcript, folded into one descriptor per top-level row (tool groups, subagent/phase
  // cards, bubbles), SCOPED to this lane. Windowed: on a long thread only the on-screen rows render.
  const items = useMemo(
    () =>
      buildLogItems(log, jobRef, { lane, phaseIds, legOrdinal, outstandingRetryTs, onOpenPlan, onSelectNode }),
    [log, jobRef, lane, phaseIds, legOrdinal, outstandingRetryTs, onOpenPlan, onSelectNode],
  );

  // The LIVE window: the in-flight turn's streaming blocks, time-merged with any mid-turn durable row (a
  // steer, notice, reminder, card, seed, etc.) by each item's real timestamp — so each row renders at the
  // moment it landed relative to the tokens streaming around it, not shoved before or after them.
  const trailing = useMemo(() => {
    if (!liveWindowActive || !liveTurn) return [];
    const liveItems = buildLiveTurnItems(liveTurn, lane, onSelectNode);
    const tsByKey = new Map(midTurnRows.map((m) => [m.ts, messagePostedMs(m)]));
    const itemTs = (key: string) =>
      tsByKey.get(key.startsWith("tg-") ? key.slice(3) : key) ??
      Number.POSITIVE_INFINITY;
    const midItems = buildLogItems(midTurnRows, jobRef, {
      lane,
      phaseIds,
      legOrdinal,
      outstandingRetryTs,
      onOpenPlan,
      onSelectNode,
    }).map((it) => ({ ...it, ts: itemTs(it.key) }));
    return [...liveItems, ...midItems].sort((a, b) => a.ts - b.ts);
  }, [
    liveTurn,
    liveWindowActive,
    midTurnRows,
    lane,
    phaseIds,
    legOrdinal,
    outstandingRetryTs,
    jobRef,
    onOpenPlan,
    onSelectNode,
  ]);

  // Unanswered question cards on the Main lane (each card's message `ts` IS its LogItem key). The operator
  // can jump to a buried one via the pinned chip below instead of scrolling the transcript to hunt for it.
  const openQuestions = useMemo(() => {
    if (!composer || readOnly) return [] as JobMessage[];
    return messages.filter((m) => {
      const c = m.card;
      return c?.type === "question_card" && !c.answer && !c.withdrawnAt;
    });
  }, [messages, composer, readOnly]);

  // `pin` snaps the view to the bottom for the virtualized case (see useTailFollow). Assigned into a ref so
  // the callback passed to useTailFollow stays stable while still reaching the freshly-built `virtualizer`
  // (which itself depends on the scrollRef useTailFollow returns — the ref breaks that render-order cycle).
  const pinRef = useRef<() => void>(() => {});
  const {
    scrollRef,
    endRef,
    showJump,
    jumpToLatest,
    onScroll,
    onPointerOver,
    onPointerLeave,
  } = useTailFollow(
    [
      messages.length,
      live,
      liveBlockCount,
      liveStreamSig,
      turnActive,
      composerHeight,
      trailing.length,
    ],
    () => pinRef.current(),
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => items[index].key,
  });

  pinRef.current = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Land near the last durable row using the virtualizer (accounts for estimated off-screen heights)…
    if (items.length > 0)
      virtualizer.scrollToIndex(items.length - 1, { align: "end" });
    // …then, once layout settles, pin to the true bottom so the trailing live turn / composer spacer are
    // included (they render in normal flow AFTER the windowed list, so `scrollHeight` is exact).
    requestAnimationFrame(() => {
      const e = scrollRef.current;
      if (e) e.scrollTop = e.scrollHeight;
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  // Scroll to the next unanswered question (cycles oldest→newest on repeated clicks) and flash its card.
  const jumpToOpenQuestion = () => {
    if (openQuestions.length === 0) return;
    const i = cycleRef.current % openQuestions.length;
    cycleRef.current = i + 1;
    const ts = openQuestions[i].ts;
    const idx = items.findIndex((it) => it.key === ts);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    setFlashKey(ts);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashKey(null), 2200);
  };

  return (
    <div className="relative min-h-0 flex-1" {...dropHandlers}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerOver={onPointerOver}
        onPointerLeave={onPointerLeave}
        className="h-full overflow-y-auto px-7 pt-5"
      >
        <div className="mx-auto flex max-w-[880px] flex-col gap-[9px]">
          {isLoading && messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">
              Loading conversation…
            </p>
          ) : items.length === 0 && trailing.length === 0 && liveBlockCount === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">
              {emptyText ?? "No messages yet — say something to Atlas below."}
            </p>
          ) : (
            // Windowed durable log: a single spacer sized to the full transcript, with only the on-screen
            // rows rendered and absolutely positioned. `measureElement` re-measures async height changes
            // (mermaid diagrams, code highlighting) so rows never overlap once they finish rendering.
            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualItems.map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={`absolute left-0 top-0 w-full${
                    items[vi.index].key === flashKey
                      ? " rounded-lg ring-2 ring-accent ring-offset-2 ring-offset-surface transition"
                      : ""
                  }`}
                  style={{
                    transform: `translateY(${vi.start}px)`,
                    paddingBottom: 9,
                  }}
                >
                  {items[vi.index].node}
                </div>
              ))}
            </div>
          )}
          {trailing.map((it) => (
            <div key={it.key}>{it.node}</div>
          ))}
          {(live || turnActive) && liveAllowed ? (
            <LiveIndicator turn={turnActive ? liveTurn : undefined} />
          ) : null}
          {/* Spacer so the last line clears the floating composer (or just breathes on read-only lanes). */}
          <div className="shrink-0" style={{ height: bottomPad }} aria-hidden />
          <div ref={endRef} />
        </div>
      </div>
      {showJump ? (
        <JumpToLatestButton
          onClick={jumpToLatest}
          style={{ bottom: bottomPad + 8 }}
        />
      ) : null}
      {openQuestions.length > 0 ? (
        <OpenQuestionsChip
          count={openQuestions.length}
          onClick={jumpToOpenQuestion}
          style={{ bottom: bottomPad + 8 }}
        />
      ) : null}
      {composer ? (
        <Composer
          jobRef={jobRef}
          attach={attach}
          onHeightChange={setComposerHeight}
          footer={footer}
          readOnly={readOnly}
        />
      ) : null}
      {/* Drag-over affordance — covers the whole pane; `pointer-events-none` so the drop still lands on the
          root's handlers (a capturing overlay would fire dragleave the instant it appeared and flicker). */}
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/5 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-surface/90 px-6 py-4 text-[13px] font-medium text-accent shadow-lg">
            <Upload size={16} strokeWidth={2.2} />
            Drop files to attach
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A pinned "N awaiting you" chip, shown whenever the Main lane has unanswered question cards. Clicking it
 * scrolls to the next open question (cycling on repeated clicks) and flashes it — so a card buried by a wall
 * of the brain's thinking is one click away instead of a scroll-hunt. Anchored bottom-LEFT so it never
 * collides with the centered {@link JumpToLatestButton}.
 */
function OpenQuestionsChip({
  count,
  onClick,
  style,
}: {
  count: number;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        count > 1
          ? `Jump to the next of ${count} unanswered questions`
          : "Jump to the unanswered question"
      }
      style={style}
      className="absolute left-4 z-10 flex items-center gap-1.5 rounded-full border border-accent bg-surface-2 py-1.5 pl-2.5 pr-3.5 text-[12px] font-medium text-accent shadow-md transition hover:bg-surface"
    >
      <HelpCircle size={14} />
      {count > 1 ? `${count} awaiting you` : "Awaiting you"}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}

function messagePostedMs(message: JobMessage): number {
  const ms = Date.parse(message.postedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** One windowable top-level row of the durable transcript — a stable key plus its rendered node. */
interface LogItem {
  key: string;
  node: React.ReactNode;
}

/**
 * Fold the durable transcript into one {@link LogItem} per top-level row, collapsing runs of consecutive
 * tool messages into `ToolGroup`s (file-edits split into their own "N files changed" group via
 * {@link segmentToolRun}) while every other kind becomes its own typed block. The returned array is what
 * the conversation virtualizes — each entry is one measured, independently-windowed row.
 */
function buildLogItems(
  log: JobMessage[],
  jobRef: JobRef,
  opts: {
    /** Which lane to build items for — scopes membership + peeling. */
    lane?: string;
    /** For a build THREAD lane (an aggregate of several phases): the anchor step ids to include. When set it
     *  supersedes the single `phase:<id>` derived from `lane` (the lane still picks the live turn). */
    phaseIds?: Set<string>;
    /** For a per-LEG view: show only build rows tagged `meta.legOrdinal === this` (untagged rows = Leg 1). */
    legOrdinal?: number;
    /** The `ts` of the currently-OUTSTANDING retryable failure card (the only one whose "Resume" button is
     *  live). Null when the thread has resumed — every failure card then shows a muted "Resumed" instead. */
    outstandingRetryTs?: string | null;
    onOpenPlan?: () => void;
    onSelectNode?: (node: string) => void;
  } = {},
): LogItem[] {
  const { lane = MAIN_LANE, legOrdinal, outstandingRetryTs = null, onOpenPlan, onSelectNode } = opts;
  const nodes: LogItem[] = [];
  let pending: Array<{ key: string; tool: ToolItem }> = [];

  // Nesting indices — computed once, then interpreted RELATIVE to the current lane below. A block that is a
  // "child" of a deeper lane is peeled out (hidden) here and rendered in ITS lane; the block that ANCHORS a
  // deeper lane (a Task tool, a build_anchor, a Codex findings summary) renders as a compact card that opens
  // that lane. This is the whole "all lanes are the same, just nested" model in one place.
  const sub = indexDurableSubagents(log);
  const phase = indexPhaseBlocks(log);
  const codex = indexCodexReviewBlocks(log);
  const autofix = indexAutofixBlocks(log);

  // Decompose the lane once (shared with the footer selector so membership never drifts). A build
  // thread/step lane streams on the STABLE `thread:<id>` lane and always passes `phaseIds` (the step
  // anchors to render); the legacy `phase:<id>` derivation is a fallback for any old lane string. An
  // auto-fix sub-page lane is `autofix:<autofixId>:<lensId>` (a review lens) OR `autofix:<autofixId>:fix`
  // (the post-review fix turn) — a lens block carries `meta.lensId`, the fix turn carries `meta.fixTurn`.
  const {
    isMain,
    isCodexLane,
    phaseSet,
    isAutofixLane,
    reviewAutofixId,
    reviewLensId,
    isFixLane,
  } = parseLane(lane, opts.phaseIds);

  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending.map((p) => p.tool))) {
      const key = `tg-${seg[0].key}`;
      nodes.push({ key, node: <ToolGroup key={key} tools={seg} /> });
    }
    pending = [];
  };

  // The Task block that spawned a subagent → a compact card opening the run's sub-page (used in any lane
  // that CONTAINS a subagent: Main, and a build phase lane).
  const pushSubagentCard = (message: JobMessage) => {
    flush();
    const summary = sub.summaryById.get(String(message.meta?.id));
    if (summary)
      nodes.push({
        key: message.ts,
        node: (
          <SubagentCard
            key={message.ts}
            summary={summary}
            onOpen={() => onSelectNode?.(subagentNode(lane, summary.parentId))}
          />
        ),
      });
  };

  for (const message of log) {
    // ── the initial-prompt block: THIS turn's "first message" (the exact task the engine received) ──
    // It's tagged with its lane's peel key (codexReviewId / phaseId / autofixId), or none for the brain's
    // `main` turn. Render it INLINE at its chronological position (a Codex review is ONE lane across many
    // rounds; the gate shares the build lane across iterations — so each round/iteration opens with its own
    // prompt, never hoisted). Handled here, before `classifyMessage`, else an atlas-authored row falls
    // through as a normal bubble. A prompt that doesn't belong to THIS lane is simply skipped.
    if (message.kind === "agent_prompt") {
      const m = message.meta ?? {};
      const cid = typeof m.codexReviewId === "string" ? m.codexReviewId : null;
      const pid = typeof m.phaseId === "string" ? m.phaseId : null;
      const aid = typeof m.autofixId === "string" ? m.autofixId : null;
      let show = false;
      if (isMain)
        // The brain's Main transcript mirrors the agent's turns via typed durable rows (operator bubble,
        // system_notice/system_reminder/untrusted pills) — so the raw serialized prompt snapshot is pure
        // duplication here and is NOT rendered. It stays on the agent sub-lanes below, which have no
        // per-chunk rows, so the prompt is their only record of what the sub-agent was asked.
        show = false;
      else if (isCodexLane) show = cid != null;
      else if (phaseSet) show = pid != null && phaseSet.has(pid);
      else if (isAutofixLane)
        show =
          aid === reviewAutofixId &&
          (isFixLane ? m.fixTurn === true : m.lensId === reviewLensId);
      if (show) {
        flush();
        nodes.push({
          key: message.ts,
          // Collapsed on Main (the operator's message bubble already shows the gist; the disclosure reveals
          // the folded context); expanded on the agent sub-lanes (seeing the prompt is the whole point).
          node: (
            <AgentPromptBlock
              key={message.ts}
              text={message.text}
              defaultOpen={!isMain}
            />
          ),
        });
      }
      continue;
    }
    // ── lane membership: which blocks THIS lane renders + which anchors become cards ──
    if (isMain) {
      // Deeper lanes' blocks are peeled out; their anchors render as cards.
      if (sub.childKeys.has(message.ts)) continue;
      if (phase.childKeys.has(message.ts)) continue;
      if (codex.childKeys.has(message.ts)) continue;
      // Auto-fix review blocks + the stage anchor row are peeled too — no card surface exists yet (see
      // `review-lane.ts`), so they simply don't render in Main; the full transcript lives in the `rev:`
      // sub-page. The stage's plain "Reviewing the diff — …" notice line (a separate, untagged message)
      // still renders normally, so the operator isn't left with zero signal.
      if (autofix.childKeys.has(message.ts)) continue;
      if (autofix.anchorKeys.has(message.ts)) continue;
      if (codex.anchorKeys.has(message.ts)) {
        flush();
        nodes.push({
          key: message.ts,
          node: (
            <CodexReviewCard
              key={message.ts}
              jobId={jobRef.jobId}
              message={message}
              onOpen={() => onSelectNode?.(codexReviewNode(jobRef.jobId))}
            />
          ),
        });
        continue;
      }
      if (phase.anchorKeys.has(message.ts)) {
        flush();
        const phaseId =
          typeof message.meta?.phaseId === "string" ? message.meta.phaseId : "";
        const anchor = phase.anchorByPhase.get(phaseId);
        if (anchor)
          nodes.push({
            key: message.ts,
            node: (
              <BuildStepCard
                key={message.ts}
                jobId={jobRef.jobId}
                anchor={anchor}
                durableToolCount={
                  (phase.blocksByPhase.get(phaseId) ?? []).filter(
                    (m) => m.kind === "tool",
                  ).length
                }
                onOpen={() => onSelectNode?.(phaseId)}
              />
            ),
          });
        continue;
      }
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
    } else if (isCodexLane) {
      // The Codex review lane shows ONLY its own review stream (the summary cards live in Main).
      if (!codex.childKeys.has(message.ts)) continue;
    } else if (phaseSet) {
      // A build lane shows its phase(s)' blocks; a subagent spawned within it peels to its own sub-page.
      if (sub.childKeys.has(message.ts)) continue;
      // Per-LEG slice: when a specific Leg is selected, drop rows tagged to a DIFFERENT Leg. Untagged rows
      // (pre-legOrdinal history) default to Leg 1. Checked BEFORE the anchor branch so the Leg-1 build
      // instruction doesn't leak into a later Leg's view.
      if (legOrdinal != null) {
        const lo =
          typeof message.meta?.legOrdinal === "number" ? message.meta.legOrdinal : 1;
        if (lo !== legOrdinal) continue;
      }
      const pid =
        typeof message.meta?.phaseId === "string" ? message.meta.phaseId : "";
      // The synthetic build_anchor row → the phase's INPUT bubble (the instruction the engine received),
      // rendered exactly like an operator prompt so every lane opens with "what was asked".
      if (phase.anchorKeys.has(message.ts)) {
        if (!phaseSet.has(pid)) continue;
        const anchor = phase.anchorByPhase.get(pid);
        if (anchor?.prompt) {
          flush();
          nodes.push({
            key: message.ts,
            node: <BuildInstruction key={message.ts} text={anchor.prompt} />,
          });
        }
        continue;
      }
      if (!(phase.childKeys.has(message.ts) && phaseSet.has(pid))) continue;
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
    } else if (isAutofixLane) {
      // An auto-fix sub-lane shows only its OWN blocks: the fix turn matches `meta.fixTurn` (no lensId), a
      // review lens matches `meta.lensId`. A subagent spawned within it peels to its own sub-page.
      const m = message.meta ?? {};
      if (m.autofixId !== reviewAutofixId) continue;
      if (isFixLane ? m.fixTurn !== true : m.lensId !== reviewLensId) continue;
      if (sub.childKeys.has(message.ts)) continue;
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
    } else {
      continue; // an unknown lane renders nothing
    }

    // ── shared rendering (IDENTICAL across every lane) ──

    // A per-turn accounting block (token usage + context occupancy) — rendered as a turn-end divider.
    // Handled raw, BEFORE classifyMessage (which would otherwise fall this unknown kind through to a
    // plain Claude bubble). Flush any open tool run first so the divider lands after the turn's tools.
    if (message.kind === "turn_meta") {
      flush();
      nodes.push({
        key: message.ts,
        node: <TurnMetaDivider key={message.ts} message={message} />,
      });
      continue;
    }

    const c = classifyMessage(message);
    if (c.kind === "tool") {
      const m = message.meta ?? {};
      pending.push({
        key: message.ts,
        tool: {
          key: message.ts,
          name: String(m.name ?? "tool"),
          input: m.input,
          result: m.result,
          isError: Boolean(m.isError),
          structuredPatch: m.structuredPatch as ToolItem["structuredPatch"],
        },
      });
      continue;
    }
    flush();

    const push = (node: React.ReactNode) =>
      nodes.push({ key: message.ts, node });
    // Interactive cards (buttons/inputs the operator clicks) are wrapped in `data-tailpause` so hovering
    // ANYWHERE on the card — not just its controls — suspends tail-follow (see useTailFollow), keeping the
    // target still under the cursor while tokens stream in.
    const pushCard = (node: React.ReactNode) =>
      push(<div data-tailpause>{node}</div>);
    switch (c.kind) {
      case "user":
        push(
          <UserBubble
            key={message.ts}
            text={message.text}
            time={message.postedAt}
            pending={message.local}
          />,
        );
        break;
      case "thinking":
        push(
          <ThinkingBlock
            key={message.ts}
            text={message.text}
            time={message.postedAt}
          />,
        );
        break;
      case "approval":
        pushCard(
          <ApprovalCardView
            key={message.ts}
            card={c.card}
            jobRef={jobRef}
            onOpenPlan={onOpenPlan}
          />,
        );
        break;
      case "verdict":
        pushCard(<VerdictCardView key={message.ts} card={c.card} />);
        break;
      case "question":
        pushCard(
          <QuestionCardView key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "secret":
        pushCard(
          <SecretCardView key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "mcp_proposal":
        pushCard(
          <McpProposalCard key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "skill_proposal":
        pushCard(
          <SkillProposalCard key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "ticket":
        pushCard(
          <TicketCardView key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "file":
        pushCard(
          <FileCardView key={message.ts} card={c.card} jobRef={jobRef} />,
        );
        break;
      case "review_comments":
        pushCard(
          <ReviewCommentsCardView
            key={message.ts}
            card={c.card}
            time={message.postedAt}
          />,
        );
        break;
      case "attachments":
        pushCard(
          <AttachmentsCardView
            key={message.ts}
            card={c.card}
            jobRef={jobRef}
            time={message.postedAt}
          />,
        );
        break;
      case "event":
        push(
          <SystemEventPill key={message.ts} message={message} tone={c.tone} />,
        );
        break;
      case "compaction":
        push(
          <CompactionSummaryPill
            key={message.ts}
            message={message}
            tone={c.tone}
            summary={c.summary}
          />,
        );
        break;
      case "system_shared":
        push(<HarnessBubble key={message.ts} message={message} />);
        break;
      case "system_event":
        push(<EventBubble key={message.ts} message={message} />);
        break;
      case "system_operator":
        push(
          <SystemOperatorNotice
            key={message.ts}
            message={message}
            jobRef={jobRef}
            isOutstanding={message.ts === outstandingRetryTs}
          />,
        );
        break;
      case "system_notice":
        push(<SystemNoticeRow key={message.ts} message={message} />);
        break;
      case "system_reminder":
        push(<SystemReminderChip key={message.ts} message={message} />);
        break;
      case "untrusted":
        push(<UntrustedBlock key={message.ts} message={message} />);
        break;
      case "claude":
      default:
        push(<ClaudeBubble key={message.ts} message={message} />);
        break;
    }
  }
  flush();

  return nodes;
}

/**
 * The AUTHORITATIVE "the AI is idle" signal for one job, from the server-owned realtime inbox row
 * (`needsYou`, kept live by `useAllJobsRealtime`). `needsYou === true` means the brain is NOT running a turn
 * and the thread isn't terminal — so a lingering live turn (dropped `turn_end`) should be treated as over.
 * Returns `false` when `jobId` is null (non-Main lanes don't cross-check) or the row isn't cached yet, so
 * the SSE stream stays the sole signal until realtime confirms otherwise (never a false "not working").
 */
function useRealtimeIdle(jobId: string | null): boolean {
  const { data: threads } = useAllJobs();
  if (!jobId) return false;
  return threads?.find((t) => t.id === jobId)?.needsYou ?? false;
}

/**
 * Live "an unresolved turn-failure box is outstanding" bit for one job, from the same server-owned realtime
 * inbox row (`halted`, kept live by `useAllJobsRealtime`) — the durable signal a failed turn's "Resume" card
 * keys off. Returns `undefined` when the row isn't cached yet, so callers keep showing Resume until realtime
 * confirms the thread has actually resumed (never hide a genuinely-needed button on a cold cache).
 */
function useThreadHalted(jobId: string | null): boolean | undefined {
  const { data: threads } = useAllJobs();
  if (!jobId) return undefined;
  return threads?.find((t) => t.id === jobId)?.halted;
}

/** The parsed identity of a transcript lane — the ONE place a lane string is decomposed, shared by
 *  `buildLogItems` (membership/peeling) and `laneMetaBelongs` (footer selection) so they never drift. */
interface ParsedLane {
  isMain: boolean;
  isCodexLane: boolean;
  /** For a build THREAD/step lane: the anchor step ids this lane aggregates (else null). */
  phaseSet: Set<string> | null;
  isAutofixLane: boolean;
  reviewAutofixId: string | null;
  reviewLensId: string | null;
  isFixLane: boolean;
}

/** Decompose a lane token (+ optional explicit build `phaseIds`) into its {@link ParsedLane} identity. */
function parseLane(lane: string, phaseIds?: Set<string>): ParsedLane {
  const isMain = lane === MAIN_LANE;
  const isCodexLane = lane.startsWith("codex-review:");
  const phaseAnchor = lane.startsWith("phase:")
    ? lane.slice("phase:".length)
    : null;
  const phaseSet: Set<string> | null =
    phaseIds ?? (phaseAnchor ? new Set([phaseAnchor]) : null);
  const isAutofixLane = lane.startsWith("autofix:");
  const autofixParts = isAutofixLane ? lane.split(":") : null; // ['autofix', autofixId, lensId|'fix']
  const reviewAutofixId = autofixParts?.[1] ?? null;
  const reviewLensId = autofixParts?.[2] ?? null;
  const isFixLane = reviewLensId === "fix";
  return {
    isMain,
    isCodexLane,
    phaseSet,
    isAutofixLane,
    reviewAutofixId,
    reviewLensId,
    isFixLane,
  };
}

/** The lane-tag fields the backend stamps on a `turn_meta` block (via the harness `metaTag`). */
interface LaneMeta {
  phaseId?: string | null;
  legOrdinal?: number | null;
  codexReviewId?: string | null;
  autofixId?: string | null;
  lensId?: string | null;
  fixTurn?: boolean | null;
  shipId?: string | null;
}

/** Does a `turn_meta`'s lane tag belong to `lane`? Mirrors `buildLogItems`' membership exactly. */
function laneMetaBelongs(meta: LaneMeta, p: ParsedLane): boolean {
  if (p.isCodexLane) return meta.codexReviewId != null;
  if (p.isAutofixLane)
    return (
      meta.autofixId === p.reviewAutofixId &&
      (p.isFixLane ? meta.fixTurn === true : meta.lensId === p.reviewLensId)
    );
  if (p.phaseSet)
    return typeof meta.phaseId === "string" && p.phaseSet.has(meta.phaseId);
  // Main (the brain): no lane tag at all — crucially INCLUDING no `shipId` (the build-ship lane writes
  // `turn_meta` with only `{ shipId }`, which would otherwise masquerade as the brain's footer).
  return (
    meta.phaseId == null &&
    meta.codexReviewId == null &&
    meta.autofixId == null &&
    meta.shipId == null
  );
}

/**
 * The composer footer for a given lane — the model/effort/engine of the lane's most recent reporting
 * turn, plus its last reported context occupancy. Scans `messages` (the FULL unscoped list) backward,
 * scoped to the lane via {@link laneMetaBelongs}:
 *  - model/effort/engine: taken from the latest matching `turn_meta`'s `usage` (regardless of context
 *    numbers — a Codex lane carries no occupancy but still has a model/effort to show).
 *  - context: the latest matching block that carries usable `contextTokens`+`contextLimit` (may be an
 *    OLDER block than the model one — matches "last reported occupancy", Claude-Code style, so the ring
 *    doesn't flicker out on a turn whose result lacked a usage block).
 */
function laneFooterMeta(
  messages: JobMessage[],
  lane: string,
  phaseIds?: Set<string>,
  legOrdinal?: number,
): ComposerFooter | null {
  const p = parseLane(lane, phaseIds);
  let model: string | undefined;
  let effort: string | undefined;
  let engine: string | undefined;
  let context: ComposerFooter["context"] = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== "turn_meta") continue;
    const meta = (m.meta ?? {}) as LaneMeta & {
      contextTokens?: number | null;
      contextLimit?: number | null;
      usage?: {
        model?: string;
        contextModel?: string;
        engine?: string;
        reasoningEffort?: string;
      };
    };
    if (!laneMetaBelongs(meta, p)) continue;
    // Per-Leg footer ring: only the selected Leg's turn_meta counts (untagged = Leg 1).
    if (legOrdinal != null && p.phaseSet) {
      const lo = typeof meta.legOrdinal === "number" ? meta.legOrdinal : 1;
      if (lo !== legOrdinal) continue;
    }
    const u = meta.usage ?? {};
    if (model === undefined && engine === undefined) {
      // First (newest) matching block wins the model/effort/engine. Prefer `contextModel` (the MAIN
      // agent's own model, from parent-unset messages) over `model` — mirrors the ring (line ~945) and
      // heals older rows whose `usage.model` recorded a whole-turn billing key (e.g. a Haiku helper).
      model = u.contextModel ?? u.model;
      effort = u.reasoningEffort;
      engine = u.engine;
    }
    if (
      !context &&
      typeof meta.contextTokens === "number" &&
      typeof meta.contextLimit === "number" &&
      meta.contextLimit > 0
    ) {
      context = {
        tokens: meta.contextTokens,
        limit: meta.contextLimit,
        model: u.contextModel ?? u.model,
      };
    }
    if ((model !== undefined || engine !== undefined) && context) break;
  }
  if (model === undefined && effort === undefined && engine === undefined && !context)
    return null;
  return { model, effort, engine, context };
}

/**
 * The lane's STATIC footer default (`model · effort`) as a {@link ComposerFooter} — used when the lane has no
 * `turn_meta` yet (before its first turn completes). No `context` ring (occupancy is unknown until a turn
 * runs). Returns null when there's no default (very old pipeline payloads), so the footer just stays blank.
 */
function defaultFooterAsComposer(d?: LaneDefaultFooter): ComposerFooter | null {
  if (!d) return null;
  return { model: d.model, effort: d.effort, engine: d.engine, context: null };
}

/**
 * The conversation top bar — the shared {@link DetailTopBar} with a lane-style left title and the standard
 * action cluster on the right, so it matches every lane/detail header exactly. (The context-window ring
 * lives in the composer's bottom-right, Claude-Code style.)
 */
function ConversationTopBar() {
  return <DetailTopBar title="Conversation" subtitle="the job brain" />;
}
