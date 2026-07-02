'use client';

import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { classifyMessage } from './classify';
import { JumpToLatestButton, useTailFollow } from './tail-follow';
import {
  ClaudeBubble,
  EventBubble,
  HarnessBubble,
  LiveIndicator,
  LiveTurnView,
  SystemEventPill,
  SystemOperatorNotice,
  ThinkingBlock,
  TurnMetaDivider,
  UserBubble,
} from './bubbles';
import { ToolGroup, segmentToolRun, type ToolItem } from './tool-calls';
import { ApprovalCardView, VerdictCardView } from './approval-card';
import { QuestionCardView } from './question-card';
import { SecretCardView } from './secret-card';
import { FileCardView } from './file-card';
import { ReviewCommentsCardView } from './review-comments-card';
import { SubagentCard, indexDurableSubagents, subagentNode } from './subagents';
import { BuildInstruction, BuildStepCard, indexPhaseBlocks } from './phases';
import { CodexReviewCard, codexReviewNode, indexCodexReviewBlocks } from './codex-review';
import { indexAutofixBlocks } from './review-lane';
import { indexPrReviewBlocks } from './pr-review';
import { Composer } from './composer';
import { DetailTopBar } from './detail-top-bar';
import type { JobMessage, JobRef } from '@/lib/api/job-api';
import { MAIN_LANE, useLiveTurn } from '@/lib/api/job-stream';
import { useQueuedSends } from '@/lib/api/queued-sends';

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
  onOpenPlan,
  onSelectNode,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  isLoading: boolean;
  live: boolean;
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
  composer = false,
  isLoading = false,
  live = false,
  emptyText,
  onOpenPlan,
  onSelectNode,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  /** Which lane's transcript this renders — `'main'` | `codex-review:<jobId>` | `thread:<threadId>`. */
  lane?: string;
  /** For a build THREAD lane: the phase anchor ids to aggregate (the `lane` still picks the live turn). */
  phaseIds?: Set<string>;
  /** Show the composer + queued-send treatment (the Main lane only). Other lanes are read-only. */
  composer?: boolean;
  isLoading?: boolean;
  live?: boolean;
  /** The empty-state line when the lane has no activity yet. */
  emptyText?: string;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
}) {
  // The composer is a floating overlay; thread its height so the transcript reserves matching space and
  // the last line never slips under it as the box auto-grows. Read-only lanes just reserve a small pad.
  const [composerHeight, setComposerHeight] = useState(116);
  const bottomPad = composer ? composerHeight : 20;
  const liveTurn = useLiveTurn(jobRef.jobId, lane);
  const liveBlockCount = liveTurn?.blocks.length ?? 0;
  const turnActive = liveTurn?.active ?? false;
  // Stream signature — grows with streaming text/thinking so the tail follows token-by-token, not just on
  // block boundaries.
  const liveStreamSig = (liveTurn?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'tool' ? 1 : b.text.length),
    0,
  );

  // Messages sent while a turn is streaming are QUEUED behind it (the brain serializes turns per thread).
  // Pull them out of the main log and render them below the live response with a "queued" treatment — so
  // a follow-up reads as "waiting its turn", not as an already-answered message in the wrong spot. Only the
  // Main lane (composer) can enqueue sends.
  const queuedTexts = useQueuedSends(jobRef.jobId);
  const isQueued = (m: JobMessage): boolean =>
    composer && m.author === 'user' && turnActive && (m.queued === true || queuedTexts.has(m.text));
  const log = messages.filter((m) => !isQueued(m));
  const queued = composer ? messages.filter(isQueued) : [];

  // The context-window ring reads the MOST RECENT `turn_meta` block (the brain appends one per turn with
  // the last request's occupancy + the model's window). Only the composer shows the ring.
  const contextMeta = useMemo(() => (composer ? latestContextMeta(messages) : null), [messages, composer]);

  // The durable transcript, folded into one descriptor per top-level row (tool groups, subagent/phase
  // cards, bubbles), SCOPED to this lane. Windowed: on a long thread only the on-screen rows render.
  const items = useMemo(
    () => buildLogItems(log, jobRef, { lane, phaseIds, onOpenPlan, onSelectNode }),
    [log, jobRef, lane, phaseIds, onOpenPlan, onSelectNode],
  );

  // `pin` snaps the view to the bottom for the virtualized case (see useTailFollow). Assigned into a ref so
  // the callback passed to useTailFollow stays stable while still reaching the freshly-built `virtualizer`
  // (which itself depends on the scrollRef useTailFollow returns — the ref breaks that render-order cycle).
  const pinRef = useRef<() => void>(() => {});
  const { scrollRef, endRef, showJump, jumpToLatest, onScroll } = useTailFollow(
    [messages.length, live, liveBlockCount, liveStreamSig, turnActive, queued.length, composerHeight],
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
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    // …then, once layout settles, pin to the true bottom so the trailing live turn / queued sends / composer
    // spacer are included (they render in normal flow AFTER the windowed list, so `scrollHeight` is exact).
    requestAnimationFrame(() => {
      const e = scrollRef.current;
      if (e) e.scrollTop = e.scrollHeight;
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-7 pt-5">
        <div className="mx-auto flex max-w-[880px] flex-col gap-[9px]">
          {isLoading && messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">Loading conversation…</p>
          ) : messages.length === 0 && liveBlockCount === 0 ? (
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
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)`, paddingBottom: 9 }}
                >
                  {items[vi.index].node}
                </div>
              ))}
            </div>
          )}
          {liveTurn && liveBlockCount > 0 ? <LiveTurnView turn={liveTurn} onSelectNode={onSelectNode} /> : null}
          {live || turnActive ? <LiveIndicator /> : null}
          {queued.map((message) =>
            message.card?.type === 'review_comments_card' ? (
              <ReviewCommentsCardView key={message.ts} card={message.card} />
            ) : (
              <UserBubble key={message.ts} text={message.text} queued />
            ),
          )}
          {/* Spacer so the last line clears the floating composer (or just breathes on read-only lanes). */}
          <div className="shrink-0" style={{ height: bottomPad }} aria-hidden />
          <div ref={endRef} />
        </div>
      </div>
      {showJump ? <JumpToLatestButton onClick={jumpToLatest} style={{ bottom: bottomPad + 8 }} /> : null}
      {composer ? <Composer jobRef={jobRef} onHeightChange={setComposerHeight} context={contextMeta} /> : null}
    </div>
  );
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
    onOpenPlan?: () => void;
    onSelectNode?: (node: string) => void;
  } = {},
): LogItem[] {
  const { lane = MAIN_LANE, onOpenPlan, onSelectNode } = opts;
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
  const prReview = indexPrReviewBlocks(log);

  const isMain = lane === MAIN_LANE;
  // The pinned PR Review thread's lane: `pr-review:<jobId>` — see `pr-review.ts`.
  const isPrReviewLane = lane.startsWith('pr-review:');
  const isCodexLane = lane.startsWith('codex-review:');
  // A build thread/step lane streams on the STABLE `thread:<id>` lane and always passes `phaseIds` (the step
  // anchors to render); the legacy `phase:<id>` derivation is a fallback for any old lane string.
  const phaseAnchor = lane.startsWith('phase:') ? lane.slice('phase:'.length) : null;
  const phaseSet: Set<string> | null =
    opts.phaseIds ?? (phaseAnchor ? new Set([phaseAnchor]) : null);
  // A review-lens sub-page lane: `autofix:<autofixId>:<lensId>` — see `review-lane.ts`.
  const isReviewLensLane = lane.startsWith('autofix:');
  const reviewLensParts = isReviewLensLane ? lane.split(':') : null; // ['autofix', autofixId, lensId]
  const reviewAutofixId = reviewLensParts?.[1] ?? null;
  const reviewLensId = reviewLensParts?.[2] ?? null;

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
            onOpen={() => onSelectNode?.(subagentNode(summary.parentId))}
          />
        ),
      });
  };

  for (const message of log) {
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
      // The PR Review session's blocks + anchor row are peeled the same way — the pinned FINAL REVIEW row
      // in the navigator is the surface (its transcript is the `pr-review` lane); the stage's plain
      // "PR Review — …" notice line still renders here as the in-conversation signal.
      if (prReview.childKeys.has(message.ts)) continue;
      if (prReview.anchorKeys.has(message.ts)) continue;
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
        const phaseId = typeof message.meta?.phaseId === 'string' ? message.meta.phaseId : '';
        const anchor = phase.anchorByPhase.get(phaseId);
        if (anchor)
          nodes.push({
            key: message.ts,
            node: (
              <BuildStepCard
                key={message.ts}
                jobId={jobRef.jobId}
                anchor={anchor}
                durableToolCount={(phase.blocksByPhase.get(phaseId) ?? []).filter((m) => m.kind === 'tool').length}
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
      const pid = typeof message.meta?.phaseId === 'string' ? message.meta.phaseId : '';
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
    } else if (isReviewLensLane) {
      // A review-lens lane shows only that lens's own blocks; a subagent spawned within it peels to its own
      // sub-page, same as any other lane.
      const m = message.meta ?? {};
      if (m.autofixId !== reviewAutofixId || m.lensId !== reviewLensId) continue;
      if (sub.childKeys.has(message.ts)) continue;
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
    } else if (isPrReviewLane) {
      // The PR Review lane shows only the orchestrator session's own blocks (tagged `meta.prReviewId`);
      // a subagent spawned within it peels to its own sub-page, same as any other lane.
      if (!prReview.childKeys.has(message.ts)) continue;
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
    if (message.kind === 'turn_meta') {
      flush();
      nodes.push({ key: message.ts, node: <TurnMetaDivider key={message.ts} message={message} /> });
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
          structuredPatch: m.structuredPatch as ToolItem['structuredPatch'],
        },
      });
      continue;
    }
    flush();

    const push = (node: React.ReactNode) => nodes.push({ key: message.ts, node });
    switch (c.kind) {
      case 'user':
        push(<UserBubble key={message.ts} text={message.text} time={message.postedAt} />);
        break;
      case 'thinking':
        push(<ThinkingBlock key={message.ts} text={message.text} time={message.postedAt} />);
        break;
      case 'approval':
        push(<ApprovalCardView key={message.ts} card={c.card} jobRef={jobRef} onOpenPlan={onOpenPlan} />);
        break;
      case 'verdict':
        push(<VerdictCardView key={message.ts} card={c.card} />);
        break;
      case 'question':
        push(<QuestionCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'secret':
        push(<SecretCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'file':
        push(<FileCardView key={message.ts} card={c.card} jobRef={jobRef} />);
        break;
      case 'review_comments':
        push(<ReviewCommentsCardView key={message.ts} card={c.card} time={message.postedAt} />);
        break;
      case 'event':
        push(<SystemEventPill key={message.ts} message={message} tone={c.tone} />);
        break;
      case 'system_shared':
        push(<HarnessBubble key={message.ts} message={message} />);
        break;
      case 'system_event':
        push(<EventBubble key={message.ts} message={message} />);
        break;
      case 'system_operator':
        push(<SystemOperatorNotice key={message.ts} message={message} jobRef={jobRef} />);
        break;
      case 'claude':
      default:
        push(<ClaudeBubble key={message.ts} message={message} />);
        break;
    }
  }
  flush();

  return nodes;
}

/** The most recent `turn_meta` block's context occupancy (null until a turn has reported usage). */
function latestContextMeta(messages: JobMessage[]): { tokens: number; limit: number; model?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== 'turn_meta') continue;
    const meta = (m.meta ?? {}) as {
      contextTokens?: number | null;
      contextLimit?: number | null;
      usage?: { model?: string };
    };
    if (typeof meta.contextTokens === 'number' && typeof meta.contextLimit === 'number' && meta.contextLimit > 0) {
      return { tokens: meta.contextTokens, limit: meta.contextLimit, model: meta.usage?.model };
    }
    return null; // latest turn_meta lacked usable numbers — don't keep scanning older turns
  }
  return null;
}

/**
 * The conversation top bar — the shared {@link DetailTopBar} with a lane-style left title and the standard
 * action cluster on the right, so it matches every lane/detail header exactly. (The context-window ring
 * lives in the composer's bottom-right, Claude-Code style.)
 */
function ConversationTopBar() {
  return <DetailTopBar title="Conversation" subtitle="the job brain" />;
}
