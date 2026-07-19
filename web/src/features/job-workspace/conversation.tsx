'use client';

import { useComposerStagedAnswers } from '@/lib/api/composer-store';
import { useAllJobs } from '@/lib/api/inbox';
import type { JobMessage, JobRef } from '@/lib/api/job-api';
import { MAIN_LANE, useLiveTurn, type ContextBreakdown } from '@/lib/api/job-stream';
import type { JobBlocker, LaneDefaultFooter, WireJobActivity } from '@/lib/api/types';
import { assertNever } from '@/utils/assert';
import { useVirtualizer } from '@tanstack/react-virtual';
import { HelpCircle, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalCardView, VerdictCardView } from './approval-card';
import { ArchivedOverlay } from './archived-overlay';
import { AttachmentsCardView } from './attachments-card';
import { BlockedOverlay } from './blocked-overlay';
import {
  buildLiveTurnItems,
  ClaudeBubble,
  CompactionSummaryPill,
  EventBubble,
  HarnessBubble,
  LiveIndicator,
  SystemEventPill,
  SystemNoticeRow,
  SystemOperatorNotice,
  SystemReminderChip,
  ThinkingBlock,
  TurnMetaDivider,
  UntrustedBlock,
  UserBubble,
} from './bubbles';
import { classifyMessage } from './classify';
import { indexCodexReviewBlocks } from './codex-review';
import { Composer, type ComposerFooter } from './composer';
import { DetailTopBar } from './detail-top-bar';
import { FileCardView } from './file-card';
import { isTouchCapableDevice, PREMEASURE_MIN_ROWS, useIdlePremeasure } from './idle-premeasure';
import { extractMermaidSources, mermaidReservePx } from './markdown';
import { McpProposalCard } from './mcp-proposal-card';
import { AgentPromptBlock } from './phases';
import { QuestionCardView } from './question-card';
import { ReviewCommentsCardView } from './review-comments-card';
import { compensateAboveViewportResize } from './scroll-compensation';
import { SecretCardView } from './secret-card';
import { messageSendState } from './send-state';
import { SkillProposalCard } from './skill-proposal-card';
import { indexDurableSubagents, SubagentCard, subagentNode } from './subagents';
import { JumpToLatestButton, useTailFollow } from './tail-follow';
import { segmentToolRun, ToolGroup, type ToolItem } from './tool-calls';
import { useAttachments } from './use-attachments';
import { useFileDrop } from './use-file-drop';

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
  blocked = false,
  blockedBy = [],
  blockedSeedMessage = null,
  archived = false,
  mainThreadId,
  mainDefaultFooter,
  onOpenPlan,
  onSelectNode,
  onOpenNav,
  onOpenDetail,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  isLoading: boolean;
  live: boolean;
  /** The job is `blocked` on another job — disables the composer and pins the blocked overlay at the top. */
  blocked?: boolean;
  /** The blockers holding this job (drives the overlay's list + "Unblock now"). */
  blockedBy?: JobBlocker[];
  /** The pending seed message this job will start on when it unblocks — previewed in the blocked overlay. */
  blockedSeedMessage?: string | null;
  /** The job is `archived` — terminal and read-only, pins the archived overlay at the top. */
  archived?: boolean;
  /** The planning thread group's thread id — Main's transcript is scoped to it. Undefined for a pre-plan (`no_job`)
   *  job, where every message belongs to the single brain thread and no scoping is needed. */
  mainThreadId?: string;
  /** The Main (brain) lane's pre-turn footer default ("Opus 4.8") — shown before the first brain turn. */
  mainDefaultFooter?: LaneDefaultFooter;
  onOpenPlan?: () => void;
  /** Open a node in the right detail pane (e.g. a subagent run's sub-page). */
  onSelectNode?: (node: string) => void;
  /** Below xl: top-bar toggles for the Navigator / Detail drawers (undefined = no button, desktop). */
  onOpenNav?: () => void;
  onOpenDetail?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <ConversationTopBar onOpenNav={onOpenNav} onOpenDetail={onOpenDetail} />
      {blocked && blockedBy.length > 0 ? (
        <BlockedOverlay
          jobRef={jobRef}
          blockedBy={blockedBy}
          blockedSeedMessage={blockedSeedMessage}
        />
      ) : null}
      {archived ? <ArchivedOverlay /> : null}
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={MAIN_LANE}
        threadId={mainThreadId}
        composer
        blocked={blocked}
        archived={archived}
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
  threadId,
  composer = false,
  readOnly = false,
  blocked = false,
  archived = false,
  isLoading = false,
  live = false,
  emptyText,
  defaultFooter,
  onOpenPlan,
  onSelectNode,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  /** Which lane's transcript this renders — `'main'` | `codex-review:<jobId>` | `thread:<threadId>` |
   *  `autofix:<parentId>:<lensId>`. Used for the LIVE-turn subscription; the DURABLE log is scoped by
   *  {@link threadId} (a plain per-message field) instead. */
  lane?: string;
  /** The real thread id this lane's DURABLE transcript belongs to — the log is filtered to
   *  `message.threadId === threadId` (its subagents ride the same threadId and are peeled into cards).
   *  Undefined only for the out-of-scope Codex review lane and a pre-plan Main, where the unfiltered log is
   *  already single-thread. */
  threadId?: string;
  /** Show the composer. On Main it's interactive; on every other lane pass `readOnly` alongside. */
  composer?: boolean;
  /** Read-only lane (not Main): the composer's input + Send are disabled, but its footer stays live. */
  readOnly?: boolean;
  /** The job is `blocked` — fully disable the composer (a send would just 400). */
  blocked?: boolean;
  /** The job is `archived` — fully disable the composer, no send would be accepted (409). */
  archived?: boolean;
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

  // Touch capability is a stable device property, but Client Components still render once on the server.
  // Compute it after hydration so the SSR guard does not permanently pin touch devices to `false`.
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(isTouchCapableDevice());
  }, []);

  // The attachment tray is owned HERE (not inside the composer) so a file dropped anywhere on the pane feeds
  // the same tray the ＋ button and paste do. Drop is live only on the interactive Main composer — read-only
  // lanes and lanes without a composer ignore drags entirely.
  const attach = useAttachments(jobRef);
  const acceptsDrop = composer && !readOnly;
  const { isDragging, dropHandlers } = useFileDrop(attach.add, acceptsDrop);

  // A brief ring flash on the question card we just jumped to, so it's easy to spot after the scroll lands.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cursor for cycling the pinned "awaiting you" chip through multiple open questions on repeated clicks.
  const cycleRef = useRef(0);

  // The durable transcript, scoped to THIS lane's real thread by the message's own `threadId` field (its
  // subagents ride the same threadId and stay in, to be peeled into cards below). Undefined threadId (the
  // Codex review lane, or a pre-plan Main) leaves the already-single-thread log unfiltered.
  const scoped = useMemo(
    () => (threadId ? messages.filter((m) => m.threadId === threadId) : messages),
    [messages, threadId],
  );

  const liveTurn = useLiveTurn(jobRef.jobId, lane);
  const liveBlockCount = liveTurn?.blocks.length ?? 0;

  // The AUTHORITATIVE turn signal: the server-owned realtime `needsYou` (true = the AI is idle / awaiting
  // you — a turn is NOT running). If it flips true while a stale live turn still lingers (a dropped
  // `turn_end`), we treat the turn as OVER so the "working…" indicator self-heals OFF. Only the Main lane
  // cross-checks this — the realtime feed is job-level, so it can't gate independent build (phase) lanes,
  // and a read-only lane (composer on, but not Main) must NOT cross-check it either.
  const realtimeIdle = useRealtimeIdle(composer && !readOnly ? jobRef.jobId : null);
  const turnActive = (liveTurn?.active ?? false) && !realtimeIdle;

  // The server-owned realtime `activity` axis: distinguishes brain-owned work (`turn`/`plan_review`/
  // `base_check`, where THIS Main chat is the live surface) from DRIVER-owned work (`build`/`master_review`,
  // where a build lane owns the work and the Main brain is dormant). During a build the coarse `live` phase
  // (`status === "running"`) stays true the whole time, so without this the Main footer keeps showing
  // "Atlas is working…" for work a build lane is actually doing. Only consulted on the interactive Main lane
  // (same gate as `realtimeIdle`); a build lane's own view drives its own indicator off its own live turn.
  const activity = useRealtimeActivity(composer && !readOnly ? jobRef.jobId : null);
  const driverOwnsWork = activity === 'build' || activity === 'master_review';

  // Stream signature — grows with streaming text/thinking so the tail follows token-by-token, not just on
  // block boundaries.
  const liveStreamSig = (liveTurn?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'tool' ? 1 : b.text.length),
    0,
  );

  // Steering is server-side now: a message sent mid-turn is injected into the running turn by the backend
  // (no client queue) — a message posted mid-turn shows up in `messages` before the turn ends. So the
  // durable log (below the live turn) and the live turn itself would render it TWICE — once here, once
  // wherever it lands in `log` — unless we split it out and time-merge it into the LIVE window instead (see
  // `trailing` below). Fallback (no live turn / startedAt unknown): behave exactly as today, one flat log.
  const startedAt = liveTurn?.startedAt;
  const liveWindowActive = !!liveTurn?.active && startedAt != null;
  const midTurnRows = useMemo(
    () => (liveWindowActive ? scoped.filter((m) => messagePostedMs(m) >= startedAt!) : []),
    [scoped, liveWindowActive, startedAt],
  );
  const log = useMemo(
    () => (liveWindowActive ? scoped.filter((m) => messagePostedMs(m) < startedAt!) : scoped),
    [scoped, liveWindowActive, startedAt],
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
    for (const m of scoped) {
      if (m.source === 'system_operator' && m.meta?.retryable === true) ts = m.ts;
    }
    return ts;
  }, [scoped, openThreadHalted]);

  // The composer footer — model · effort (from the latest `turn_meta`, else the lane's config default) + the
  // context ring. Computed for every lane that shows a composer (Main + read-only), scoped to the lane. The
  // ring prefers a LIVE occupancy value (`liveTurn.contextTokens`, streamed mid-turn by the engine's `usage`
  // event) while the turn is running, so a multi-minute turn's ring fills as it goes instead of only jumping
  // at turn end; it falls back to the durable `turn_meta` occupancy between turns.
  const footer = useMemo(() => {
    if (!composer) return null;
    const base = laneFooterMeta(scoped, lane) ?? defaultFooterAsComposer(defaultFooter);
    const liveContext =
      turnActive && typeof liveTurn?.contextTokens === 'number' && liveTurn.contextLimit
        ? {
            tokens: liveTurn.contextTokens,
            limit: liveTurn.contextLimit,
            model: liveTurn.contextModel,
            contextBreakdown: liveTurn?.contextBreakdown,
          }
        : null;
    if (!liveContext) return base;
    return { ...(base ?? {}), context: liveContext };
  }, [
    composer,
    scoped,
    lane,
    defaultFooter,
    turnActive,
    liveTurn?.contextTokens,
    liveTurn?.contextLimit,
    liveTurn?.contextModel,
    liveTurn?.contextBreakdown,
  ]);

  // The durable transcript, folded into one descriptor per top-level row (tool groups, subagent/phase
  // cards, bubbles), SCOPED to this lane. Windowed: on a long thread only the on-screen rows render.
  const items = useMemo(
    () =>
      buildLogItems(log, jobRef, {
        lane,
        outstandingRetryTs,
        onOpenPlan,
        onSelectNode,
      }),
    [log, jobRef, lane, outstandingRetryTs, onOpenPlan, onSelectNode],
  );

  // The LIVE window: the in-flight turn's streaming blocks, time-merged with any mid-turn durable row (a
  // steer, notice, reminder, card, seed, etc.) by each item's real timestamp — so each row renders at the
  // moment it landed relative to the tokens streaming around it, not shoved before or after them.
  const trailing = useMemo(() => {
    if (!liveWindowActive || !liveTurn) return [];
    const liveItems = buildLiveTurnItems(liveTurn, lane, onSelectNode);
    // Effective-order instant (not raw postedAt) so a mid-turn row settles into the SAME position it will
    // hold once it crosses into history — see messageOrderMs.
    const tsByKey = new Map(midTurnRows.map((m) => [m.ts, messageOrderMs(m)]));
    const itemTs = (key: string) =>
      tsByKey.get(key.startsWith('tg-') ? key.slice(3) : key) ?? Number.POSITIVE_INFINITY;
    const midItems = buildLogItems(midTurnRows, jobRef, {
      lane,
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
    outstandingRetryTs,
    jobRef,
    onOpenPlan,
    onSelectNode,
  ]);

  // Unanswered question cards on the Main lane (each card's message `ts` IS its LogItem key). The operator
  // can jump to a buried one via the pinned chip below instead of scrolling the transcript to hunt for it.
  // A card whose answer is already staged into the send-together tray is no longer awaiting the operator, so
  // it's excluded here — the pill counts only questions that still need a pick.
  const stagedAnswers = useComposerStagedAnswers(jobRef);
  const openQuestions = useMemo(() => {
    if (!composer || readOnly) return [] as JobMessage[];
    const stagedQuestionIds = new Set(
      stagedAnswers.filter((a) => a.kind === 'question').map((a) => a.cardId),
    );
    return scoped.filter((m) => {
      const c = m.card;
      return (
        c?.type === 'question_card' &&
        !c.answer &&
        !c.withdrawnAt &&
        !stagedQuestionIds.has(c.questionId)
      );
    });
  }, [scoped, composer, readOnly, stagedAnswers]);

  // `pin` snaps the view to the bottom for the virtualized case (see useTailFollow). Assigned into a ref so
  // the callback passed to useTailFollow stays stable while still reaching the freshly-built `virtualizer`
  // (which itself depends on the scrollRef useTailFollow returns — the ref breaks that render-order cycle).
  const pinRef = useRef<() => void>(() => {});
  const { scrollRef, endRef, showJump, jumpToLatest, onScroll, onPointerOver, onPointerLeave } =
    useTailFollow(
      [
        messages.length,
        live,
        driverOwnsWork,
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
    estimateSize: (index) => items[index].estimate,
    overscan: 8,
    getItemKey: (index) => items[index].key,
    // Native bottom-anchoring (@tanstack/virtual-core ≥3.16): when the view is at/near the bottom, a row
    // resizing (a fresh row measuring taller than its estimate, an async Mermaid SVG landing) keeps the
    // bottom edge pinned via the total-size delta instead of the top-anchored predicate below — and on iOS
    // the adjustment rides the built-in deferred-scrollTop path (held through touch/momentum, flushed once on
    // settle) so it never lands as a mid-gesture jump. `scrollEndThreshold` matches useTailFollow's 80px
    // "stuck to bottom" band so the two agree on what counts as "at the end".
    anchorTo: 'end',
    scrollEndThreshold: 80,
  });

  // `shouldAdjustScrollPositionOnItemSizeChange` is a Virtualizer INSTANCE field, not a constructor
  // option — `useVirtualizer`'s options merge never copies it onto the instance, so it must be assigned
  // directly here rather than inside the options object above. It governs the SCROLLED-UP case only: when
  // NOT at the end, `anchorTo:'end'` defers to this predicate, which compensates any above-viewport resize
  // (the desktop Cause-B backstop) — again through the iOS deferred-scrollTop path when on iOS.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateAboveViewportResize;

  pinRef.current = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Incremental streaming follow (the common case — already near the bottom): a single write to the true
    // bottom. The trailing live turn / composer spacer render in normal flow AFTER the windowed list, so
    // `scrollHeight` is exact and no virtualizer scroll-to-index is needed. Doing just this one write (no
    // second rAF snap) avoids the tail jittering on every streamed token.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= el.clientHeight) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Big "jump to latest" from far up: the tail rows may be windowed out, so drive the virtualizer to
    // render them first (accounts for estimated off-screen heights)…
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    // …then, once layout settles, pin to the true bottom to include the trailing live turn / composer spacer.
    requestAnimationFrame(() => {
      const e = scrollRef.current;
      if (e) e.scrollTop = e.scrollHeight;
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  // Idle, off-screen pre-measurement of the not-yet-seen backlog's exact row heights — so a fresh tall row
  // (long markdown/code, a Mermaid diagram) already has its real height BEFORE it scrolls into view and
  // therefore never triggers a first-measure resize/scroll-compensation on iOS. The pass measures silently
  // (no scroll writes) and seeds all rows in one synchronous settle, so it's safe to run while pinned at the
  // tail — which is exactly when we want it, so the very first upward scroll is already smooth. Touch-only +
  // long transcripts (short ones have negligible residual). See idle-premeasure.tsx.
  const premeasureEnabled = isTouch && items.length >= PREMEASURE_MIN_ROWS;
  // Every ```mermaid fence in the lane-filtered durable transcript, deduped by the warm helper — handed to the
  // idle pass so it can warm the render cache off-screen BEFORE a diagram row is pre-measured.
  const warmSources = useMemo(
    () =>
      premeasureEnabled
        ? log.flatMap((m) => extractMermaidSources(typeof m.text === 'string' ? m.text : ''))
        : [],
    [log, premeasureEnabled],
  );
  const premeasureLayer = useIdlePremeasure({
    items,
    virtualizer,
    enabled: premeasureEnabled,
    warmSources,
  });

  // Scroll to the next unanswered question (cycles oldest→newest on repeated clicks) and flash its card.
  const jumpToOpenQuestion = () => {
    if (openQuestions.length === 0) return;
    const i = cycleRef.current % openQuestions.length;
    cycleRef.current = i + 1;
    const ts = openQuestions[i].ts;
    const idx = items.findIndex((it) => it.key === ts);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
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
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none] px-7 pt-5"
      >
        <div className="relative mx-auto flex max-w-220 flex-col gap-2.25">
          {premeasureLayer}
          {isLoading && messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">Loading conversation…</p>
          ) : items.length === 0 && trailing.length === 0 && liveBlockCount === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">
              {emptyText ?? 'No messages yet — say something to Atlas below.'}
            </p>
          ) : (
            // Windowed durable log: a single spacer sized to the full transcript, with only the on-screen
            // rows rendered and absolutely positioned. `measureElement` re-measures async height changes
            // (mermaid diagrams, code highlighting) so rows never overlap once they finish rendering.
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={`absolute left-0 top-0 w-full${
                    items[vi.index].key === flashKey
                      ? ' rounded-lg ring-2 ring-accent ring-offset-2 ring-offset-surface transition'
                      : ''
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
          {(live && !driverOwnsWork) || turnActive ? (
            <LiveIndicator turn={turnActive ? liveTurn : undefined} />
          ) : null}
          {/* Spacer so the last line clears the floating composer (or just breathes on read-only lanes). */}
          <div className="shrink-0" style={{ height: bottomPad }} aria-hidden />
          <div ref={endRef} />
        </div>
      </div>
      {showJump ? (
        <JumpToLatestButton onClick={jumpToLatest} style={{ bottom: bottomPad + 8 }} />
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
          lane={lane === MAIN_LANE ? undefined : lane}
          threadId={threadId}
          onHeightChange={setComposerHeight}
          footer={footer}
          readOnly={readOnly}
          blocked={blocked}
          archived={archived}
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
          : 'Jump to the unanswered question'
      }
      style={style}
      className="absolute left-4 z-10 flex items-center gap-1.5 rounded-full border border-accent bg-surface-2 py-1.5 pl-2.5 pr-3.5 text-[12px] font-medium text-accent shadow-md transition hover:bg-surface"
    >
      <HelpCircle size={14} />
      {count > 1 ? `${count} awaiting you` : 'Awaiting you'}
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

// The instant the brain PROCESSED this row (its SDK-conversation position) — what the transcript orders
// by. Falls back to delivered/posted time. Display still uses postedAt.
export function messageOrderMs(message: JobMessage): number {
  const ms = Date.parse(message.orderAt ?? message.deliveredAt ?? message.postedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** One windowable top-level row of the durable transcript — a stable key, its rendered node, and the
 *  initial height guess the virtualizer uses before the row is measured. */
interface LogItem {
  key: string;
  node: React.ReactNode;
  /** First-guess row height (px) for `estimateSize`. `measureElement` corrects it to the exact height
   *  once the row mounts; a close guess keeps that correction small so rows don't visibly shift as they
   *  scroll into view (a flat guess for every row is what made scrolling jump). */
  estimate: number;
}

/**
 * Per-row-kind initial height guesses (px), keyed by {@link classifyMessage}'s `kind`. These are rough
 * medians, not exact — the ResizeObserver in `measureElement` replaces each with the real height after the
 * row renders. Their only job is to make the FIRST guess close so `getTotalSize()` barely moves when an
 * off-screen row scrolls into view, which is what keeps scrolling smooth. Tool groups and Mermaid-bearing
 * rows are sized separately (see `toolGroupEstimate` / the `flush` sites below).
 */
const ROW_ESTIMATE: Record<string, number> = {
  // compact single-line pills / dividers
  system_notice: 40,
  system_reminder: 40,
  system_event: 44,
  event: 44,
  compaction: 48,
  // short bubbles
  user: 92,
  thinking: 26,
  system_operator: 96,
  system_shared: 96,
  untrusted: 112,
  // assistant prose — usually the tallest ordinary row
  claude: 120,
  // interactive cards (button/input surfaces)
  approval: 240,
  question: 200,
  verdict: 160,
  secret: 184,
  mcp_proposal: 200,
  skill_proposal: 200,
  file: 152,
  review_comments: 184,
  attachments: 132,
};

/** Fallback guess for a row kind not in {@link ROW_ESTIMATE} — the rough median of an ordinary row, a much
 *  closer starting point than the old flat 72px. */
const ROW_ESTIMATE_FALLBACK = 112;

/** Initial height guess for a classified message row. */
function estimateForKind(kind: string): number {
  return ROW_ESTIMATE[kind] ?? ROW_ESTIMATE_FALLBACK;
}

/** Initial height guess for a folded tool-run group — the collapsed `DisclosureRow` is a single line
 *  regardless of how many calls it folds, so the estimate is flat. */
function toolGroupEstimate(_toolCount: number): number {
  return 40;
}

/** Message kinds whose height is dominated by free-form text (markdown / code / diagrams), so a flat
 *  per-kind guess is a poor estimate — a one-line reply and a page of markdown share the same `kind`. For
 *  these we estimate from the actual content instead (see {@link estimateForMessage}). */
const TEXT_KINDS = new Set([
  'claude',
  'user',
  'untrusted',
  'system_shared',
  'compaction',
  'system_operator',
]);

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;
/** Any fenced code block (language tag optional) — used to reserve non-mermaid code at code line-height
 *  instead of letting it fall through to the prose wrapped-line math below. Run AFTER {@link MERMAID_FENCE}
 *  has already been stripped from the text, so a mermaid fence never double-matches here. */
const CODE_FENCE = /```(\w*)\n([\s\S]*?)```/g;
/** Card chrome (header bar + vertical margins) around a rendered Mermaid diagram body. */
const MERMAID_CHROME_PX = 64;
/** Rendered height of one line inside a `CodeBlock` (`text-[11.5px] leading-[1.7]` ≈ 19.5px/line) plus the
 *  header-bar + padding chrome around the block. */
const CODE_LINE_PX = 19;
const CODE_CHROME_PX = 28;
/** Approx chars per line at the ~800px content column, and the rendered height of one wrapped line. */
const CHARS_PER_LINE = 92;
const LINE_PX = 22;

/**
 * Content-aware initial height guess for a free-form text row. A flat per-kind estimate mis-sizes long
 * markdown and (badly) diagram-bearing bubbles, which is what makes the row after a tall diagram briefly
 * overlap it before `measureElement` corrects. So estimate from the text: reserve each embedded Mermaid
 * diagram at the SAME size the diagram itself reserves ({@link mermaidReservePx}), reserve each other fenced
 * code block at code line-height (code doesn't wrap like prose, so counting it as wrapped text under-counts
 * it), then add wrapped-line height for the remaining prose. Still only an estimate — the ResizeObserver sets
 * the exact height; this just makes the first guess close.
 */
function estimateForMessage(message: JobMessage, kind: string): number {
  const base = estimateForKind(kind);
  const text = typeof message.text === 'string' ? message.text : '';
  if (!TEXT_KINDS.has(kind) || text === '') return base;

  let diagrams = 0;
  MERMAID_FENCE.lastIndex = 0;
  for (let m = MERMAID_FENCE.exec(text); m !== null; m = MERMAID_FENCE.exec(text)) {
    diagrams += mermaidReservePx(m[1]) + MERMAID_CHROME_PX;
  }

  let prose = text.replace(MERMAID_FENCE, '');

  let code = 0;
  CODE_FENCE.lastIndex = 0;
  for (let m = CODE_FENCE.exec(prose); m !== null; m = CODE_FENCE.exec(prose)) {
    const lineCount = m[2].split('\n').length;
    code += lineCount * CODE_LINE_PX + CODE_CHROME_PX;
  }
  prose = prose.replace(CODE_FENCE, '');

  let lines = 0;
  for (const line of prose.split('\n'))
    lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
  const prosePx = 40 + lines * LINE_PX;

  return Math.max(base, Math.round(prosePx + diagrams + code));
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
    /** Which lane to build items for — decides subagent-only peeling vs the out-of-scope Codex lane. The
     *  durable log is already thread-scoped by the caller ({@link TranscriptView}'s `threadId` filter). */
    lane?: string;
    /** The `ts` of the currently-OUTSTANDING retryable failure card (the only one whose "Resume" button is
     *  live). Null when the thread has resumed — every failure card then shows a muted "Resumed" instead. */
    outstandingRetryTs?: string | null;
    onOpenPlan?: () => void;
    onSelectNode?: (node: string) => void;
  } = {},
): LogItem[] {
  const { lane = MAIN_LANE, outstandingRetryTs = null, onOpenPlan, onSelectNode } = opts;
  const nodes: LogItem[] = [];
  let pending: Array<{ key: string; tool: ToolItem }> = [];

  // The log arrives already scoped to ONE thread (Main, a build thread, or a review child) via the message's
  // `threadId` field. The only nested activity still peeled here is the thread's OWN spawned subagents: a
  // Task block becomes a compact card opening the run's sub-page, its child blocks render on that sub-page.
  const sub = indexDurableSubagents(log);
  // The out-of-scope Codex plan-review lane is NOT thread-scoped by the caller, so it still selects its own
  // stream by `meta.codexReviewId` (see the `isCodexLane` branch below).
  const codex = indexCodexReviewBlocks(log);

  const { isMain, isCodexLane } = parseLane(lane);

  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending.map((p) => p.tool))) {
      const key = `tg-${seg[0].key}`;
      nodes.push({
        key,
        node: <ToolGroup key={key} tools={seg} />,
        estimate: toolGroupEstimate(seg.length),
      });
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
        estimate: 184,
      });
  };

  for (const message of log) {
    // ── the initial-prompt block: THIS turn's "first message" (the exact task the engine received) ──
    // Rendered INLINE at its chronological position on every agent lane (a build thread, a review child).
    // Handled here, before `classifyMessage`, else an atlas-authored row falls through as a normal bubble.
    if (message.kind === 'agent_prompt') {
      // The brain's Main transcript mirrors the agent's turns via typed durable rows (operator bubble,
      // system_notice/system_reminder/untrusted pills) — so the raw serialized prompt snapshot is pure
      // duplication there and is NOT rendered. On the out-of-scope Codex lane it belongs only when tagged.
      const cid =
        typeof message.meta?.codexReviewId === 'string' ? message.meta.codexReviewId : null;
      const show = isMain ? false : isCodexLane ? cid != null : true;
      if (show) {
        flush();
        nodes.push({
          key: message.ts,
          node: <AgentPromptBlock key={message.ts} text={message.text} />,
          estimate: 200,
        });
      }
      continue;
    }
    // ── lane membership: peel this thread's own subagents; the Codex lane self-selects its stream ──
    if (isCodexLane) {
      // The out-of-scope Codex review lane isn't thread-scoped, so it shows ONLY its own review stream.
      if (!codex.childKeys.has(message.ts)) continue;
    } else {
      // Every thread-scoped lane (Main, a build thread, a review child): the log is already this thread's,
      // so render it all — only the thread's own spawned subagents peel out into cards.
      if (sub.childKeys.has(message.ts)) continue;
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
    }

    // ── shared rendering (IDENTICAL across every lane) ──

    // A per-turn accounting block (token usage + context occupancy) — rendered as a turn-end divider.
    // Handled raw, BEFORE classifyMessage (which would otherwise fall this unknown kind through to a
    // plain Claude bubble). Flush any open tool run first so the divider lands after the turn's tools.
    if (message.kind === 'turn_meta') {
      flush();
      nodes.push({
        key: message.ts,
        node: <TurnMetaDivider key={message.ts} message={message} />,
        estimate: 38,
      });
      continue;
    }

    const c = classifyMessage(message);
    if (c.kind === 'tool') {
      const m = message.meta ?? {};
      pending.push({
        key: message.ts,
        tool: {
          key: message.ts,
          name: String(m.name ?? 'tool'),
          input: m.input,
          result: m.result,
          isError: Boolean(m.isError),
          superseded: Boolean(m.superseded),
          structuredPatch: m.structuredPatch as ToolItem['structuredPatch'],
          jitContext: m.jitContext as ToolItem['jitContext'],
        },
      });
      continue;
    }
    flush();

    const push = (node: React.ReactNode) =>
      nodes.push({
        key: message.ts,
        node,
        estimate: estimateForMessage(message, c.kind),
      });
    // Interactive cards (buttons/inputs the operator clicks) are wrapped in `data-tailpause` so hovering
    // ANYWHERE on the card — not just its controls — suspends tail-follow (see useTailFollow), keeping the
    // target still under the cursor while tokens stream in.
    const pushCard = (node: React.ReactNode) => push(<div data-tailpause>{node}</div>);
    switch (c.kind) {
      case 'user':
        push(
          <UserBubble
            key={message.ts}
            text={message.text}
            time={message.postedAt}
            pending={messageSendState(message) === 'sending'}
          />,
        );
        break;
      case 'thinking':
        push(<ThinkingBlock key={message.ts} text={message.text} time={message.postedAt} />);
        break;
      case 'approval':
        pushCard(
          <ApprovalCardView
            key={message.ts}
            card={c.card}
            jobRef={jobRef}
            onOpenPlan={onOpenPlan}
            onSelectNode={onSelectNode}
          />,
        );
        break;
      case 'verdict':
        pushCard(<VerdictCardView key={message.ts} card={c.card} />);
        break;
      case 'question':
        pushCard(<QuestionCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'secret':
        pushCard(<SecretCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'mcp_proposal':
        pushCard(<McpProposalCard key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'skill_proposal':
        pushCard(<SkillProposalCard key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'file':
        pushCard(<FileCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'review_comments':
        pushCard(
          <ReviewCommentsCardView
            key={message.ts}
            card={c.card}
            time={message.postedAt}
            pending={messageSendState(message) === 'sending'}
          />,
        );
        break;
      case 'attachments':
        pushCard(
          <AttachmentsCardView
            key={message.ts}
            card={c.card}
            jobRef={jobRef}
            time={message.postedAt}
          />,
        );
        break;
      case 'event':
        push(<SystemEventPill key={message.ts} message={message} tone={c.tone} />);
        break;
      case 'compaction':
        push(
          <CompactionSummaryPill
            key={message.ts}
            message={message}
            tone={c.tone}
            summary={c.summary}
          />,
        );
        break;
      case 'system_shared':
        push(<HarnessBubble key={message.ts} message={message} />);
        break;
      case 'system_event':
        push(<EventBubble key={message.ts} message={message} />);
        break;
      case 'system_operator':
        push(
          <SystemOperatorNotice
            key={message.ts}
            message={message}
            jobRef={jobRef}
            lane={lane}
            isOutstanding={message.ts === outstandingRetryTs}
          />,
        );
        break;
      case 'system_notice':
        push(<SystemNoticeRow key={message.ts} message={message} />);
        break;
      case 'system_reminder':
        push(<SystemReminderChip key={message.ts} message={message} />);
        break;
      case 'untrusted':
        push(<UntrustedBlock key={message.ts} message={message} />);
        break;
      case 'build_anchor':
        // Driver bookkeeping row — no operator-facing content, explicitly not rendered.
        break;
      case 'claude':
        push(<ClaudeBubble key={message.ts} message={message} onSelectNode={onSelectNode} />);
        break;
      default:
        return assertNever(c);
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
 * The server-owned realtime `activity` axis for one job, from the same inbox row (`useAllJobsRealtime`).
 * This is what the system is DOING right now (`turn`/`plan_review`/`build`/`master_review`/`base_check`/…),
 * orthogonal to the build PHASE (`status`). The Main indicator uses it to tell brain-owned work apart from
 * driver-owned work (a running build lane) so it doesn't show "working…" for a dormant brain. Returns null
 * when `jobId` is null (non-Main lanes don't consult it) or the row isn't cached yet — callers treat null
 * as "no positive driver-owned evidence" and fall back to the coarse phase, so a cold cache never falsely
 * SUPPRESSES a genuine indicator.
 */
function useRealtimeActivity(jobId: string | null): WireJobActivity | null {
  const { data: threads } = useAllJobs();
  if (!jobId) return null;
  return threads?.find((t) => t.id === jobId)?.activity ?? null;
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
 *  `buildLogItems` (subagent-vs-codex peeling) and `laneMetaBelongs` (footer selection) so they never drift. */
interface ParsedLane {
  isMain: boolean;
  isCodexLane: boolean;
}

/** Decompose a lane token into its {@link ParsedLane} identity. */
function parseLane(lane: string): ParsedLane {
  return {
    isMain: lane === MAIN_LANE,
    isCodexLane: lane.startsWith('codex-review:'),
  };
}

/** The lane-tag fields the backend stamps on a `turn_meta` block (via the harness `metaTag`). */
interface LaneMeta {
  codexReviewId?: string | null;
}

/**
 * Does a `turn_meta` belong to `lane`'s footer? The durable log is already thread-scoped for every lane
 * EXCEPT the out-of-scope Codex review lane, which self-selects by `meta.codexReviewId`. So a thread-scoped
 * lane accepts any `turn_meta` (they're all this thread's); the Codex lane accepts only its tagged ones.
 */
function laneMetaBelongs(meta: LaneMeta, p: ParsedLane): boolean {
  if (p.isCodexLane) return meta.codexReviewId != null;
  return true;
}

/**
 * The composer footer for a given lane — the model/effort/engine of the lane's most recent reporting
 * turn, plus its last reported context occupancy. Scans the (already thread-scoped) `messages` backward:
 *  - model/effort/engine: taken from the latest matching `turn_meta`'s `usage` (regardless of context
 *    numbers — a Codex lane carries no occupancy but still has a model/effort to show).
 *  - context: the latest matching block that carries usable `contextTokens`+`contextLimit` (may be an
 *    OLDER block than the model one — matches "last reported occupancy", Claude-Code style, so the ring
 *    doesn't flicker out on a turn whose result lacked a usage block).
 */
function laneFooterMeta(messages: JobMessage[], lane: string): ComposerFooter | null {
  const p = parseLane(lane);
  let model: string | undefined;
  let effort: string | undefined;
  let engine: string | undefined;
  let context: ComposerFooter['context'] = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'turn_meta') continue;
    const meta = (m.meta ?? {}) as LaneMeta & {
      contextTokens?: number | null;
      contextLimit?: number | null;
      contextBreakdown?: ContextBreakdown | null;
      usage?: {
        model?: string;
        contextModel?: string;
        engine?: string;
        reasoningEffort?: string;
      };
    };
    if (!laneMetaBelongs(meta, p)) continue;
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
      typeof meta.contextTokens === 'number' &&
      typeof meta.contextLimit === 'number' &&
      meta.contextLimit > 0
    ) {
      context = {
        tokens: meta.contextTokens,
        limit: meta.contextLimit,
        model: u.contextModel ?? u.model,
        contextBreakdown: meta.contextBreakdown,
      };
    } else if (!context && meta.contextBreakdown) {
      // Fallback: this block's scalar occupancy is missing/invalid but it DOES carry a breakdown — let the
      // ring mount from the breakdown's own totals rather than staying blank.
      context = {
        tokens: meta.contextBreakdown.totalTokens,
        limit: meta.contextBreakdown.maxTokens,
        model: meta.contextBreakdown.model,
        contextBreakdown: meta.contextBreakdown,
      };
    }
    if ((model !== undefined || engine !== undefined) && context) break;
  }
  if (model === undefined && effort === undefined && engine === undefined && !context) return null;
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
function ConversationTopBar({
  onOpenNav,
  onOpenDetail,
}: {
  onOpenNav?: () => void;
  onOpenDetail?: () => void;
}) {
  return (
    <DetailTopBar
      title="Conversation"
      subtitle="the job brain"
      onOpenNav={onOpenNav}
      onOpenDetail={onOpenDetail}
    />
  );
}
