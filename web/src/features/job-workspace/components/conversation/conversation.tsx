'use client';

import { useComposerStagedAnswers } from '@/lib/api/composer-store';
import { useAllJobs } from '@/lib/api/inbox';
import type { JobMessage, JobRef } from '@/lib/api/job-api';
import { MAIN_LANE, useLiveTurn } from '@/lib/api/job-stream';
import type { JobBlocker, LaneDefaultFooter } from '@/lib/api/types';
import { assertNever } from '@/utils/assert';
import { useVirtualizer } from '@tanstack/react-virtual';
import { HelpCircle, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAttachments } from '../../hooks/use-attachments';
import { useFileDrop } from '../../hooks/use-file-drop';
import { useJobTurnStream } from '../../hooks/use-job-turn-stream';
import { classifyMessage } from '../../lib/classify';
import { belongsInLiveWindow, messageOrderMs, messagePostedMs } from '../../lib/message-order';
import { compensateAboveViewportResize } from '../../lib/scroll-compensation';
import { messageSendState } from '../../lib/send-state';
import { indexDurableSubagents, SubagentCard, subagentNode } from '../../subagents';
import { segmentToolRun, ToolGroup, type ToolItem } from '../../tool-calls';
import { ApprovalCardView, VerdictCardView } from '../cards/approval-card';
import { AttachmentsCardView } from '../cards/attachments-card';
import { FileCardView } from '../cards/file-card';
import { McpProposalCard } from '../cards/mcp-proposal-card';
import { QuestionCardView } from '../cards/question-card';
import { SecretCardView } from '../cards/secret-card';
import { SkillProposalCard } from '../cards/skill-proposal-card';
import { DetailTopBar } from '../chrome/detail-top-bar';
import { Composer, type ComposerFooter } from '../composer/composer';
import { ArchivedOverlay } from '../overlays/archived-overlay';
import { BlockedOverlay } from '../overlays/blocked-overlay';
import { indexCodexReviewBlocks } from '../review/codex-review';
import { ReviewCommentsCardView } from '../review/review-comments-card';
import { buildLiveTurnItems, UntrustedBlock, UserBubble } from './bubbles/bubbles';
import { ClaudeBubble } from './bubbles/ClaudeBubble';
import { CompactionSummaryPill } from './bubbles/CompactionSummaryPill';
import { EventBubble } from './bubbles/EventBubble';
import { HarnessBubble } from './bubbles/HarnessBubble';
import { LiveIndicator } from './bubbles/LiveIndicator';
import { SystemEventPill } from './bubbles/SystemEventPill';
import { SystemNoticeRow } from './bubbles/SystemNoticeRow';
import { SystemOperatorNotice } from './bubbles/SystemOperatorNotice';
import { SystemReminderChip } from './bubbles/SystemReminderChip';
import { ThinkingBlock } from './bubbles/ThinkingBlock';
import { isTouchCapableDevice, PREMEASURE_MIN_ROWS, useIdlePremeasure } from './idle-premeasure';
import { extractMermaidSources, mermaidReservePx } from './markdown';
import { PendingZone } from './pending-zone';
import { JumpToLatestButton, useTailFollow } from './tail-follow';

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
  blocked?: boolean;
  blockedBy?: JobBlocker[];
  blockedSeedMessage?: string | null;
  archived?: boolean;
  mainThreadId?: string;
  mainDefaultFooter?: LaneDefaultFooter;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
  onOpenNav?: () => void;
  onOpenDetail?: () => void;
}) {
  // Open the job's single live-turn stream once here — it feeds the live-turn store every consumer reads.
  useJobTurnStream(jobRef.jobId);
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

interface ParsedLane {
  isMain: boolean;
  isCodexLane: boolean;
}

function parseLane(lane: string): ParsedLane {
  return {
    isMain: lane === MAIN_LANE,
    isCodexLane: lane.startsWith('codex-review:'),
  };
}

export function defaultFooterAsComposer(d?: LaneDefaultFooter): ComposerFooter | null {
  if (!d) return null;
  return { model: d.model, effort: d.effort, engine: d.engine, context: null };
}

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
  lane?: string;
  threadId?: string;
  composer?: boolean;
  readOnly?: boolean;
  blocked?: boolean;
  archived?: boolean;
  isLoading?: boolean;
  live?: boolean;
  emptyText?: string;
  defaultFooter?: LaneDefaultFooter;
  onOpenPlan?: () => void;
  onSelectNode?: (node: string) => void;
}) {
  const [composerHeight, setComposerHeight] = useState(116);
  const bottomPad = composer ? composerHeight : 20;

  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    setIsTouch(isTouchCapableDevice());
  }, []);

  const attach = useAttachments(jobRef);
  const acceptsDrop = composer && !readOnly;
  const { isDragging, dropHandlers } = useFileDrop(attach.add, acceptsDrop);

  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cycleRef = useRef(0);

  const scoped = useMemo(() => {
    const lane = threadId ? messages.filter((m) => m.threadId === threadId) : messages;
    return [...lane].sort((a, b) => messageOrderMs(a) - messageOrderMs(b));
  }, [messages, threadId]);

  const liveTurn = useLiveTurn(jobRef.jobId, lane);
  const liveBlockCount = liveTurn?.blocks.length ?? 0;

  const turnActive = liveTurn?.active ?? false;

  const driverOwnsWork = false;

  const liveStreamSig = (liveTurn?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'tool' ? 1 : b.text.length),
    0,
  );

  const startedAt = liveTurn?.startedAt;
  const liveWindowActive = !!liveTurn?.active && startedAt != null;
  const midTurnRows = useMemo(
    () => (liveWindowActive ? scoped.filter((m) => belongsInLiveWindow(m, startedAt!)) : []),
    [scoped, liveWindowActive, startedAt],
  );
  const log = useMemo(
    () => (liveWindowActive ? scoped.filter((m) => messagePostedMs(m) < startedAt!) : scoped),
    [scoped, liveWindowActive, startedAt],
  );

  const openThreadHalted = useThreadHalted(jobRef.jobId);
  const outstandingRetryTs = useMemo<string | null>(() => {
    if (openThreadHalted === false) return null;
    let ts: string | null = null;
    for (const m of scoped) {
      if (m.source === 'system_operator' && m.meta?.retryable === true) ts = m.ts;
    }
    return ts;
  }, [scoped, openThreadHalted]);

  const footer = useMemo(() => {
    if (!composer) return null;
    const base = defaultFooterAsComposer(defaultFooter);
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
    defaultFooter,
    turnActive,
    liveTurn?.contextTokens,
    liveTurn?.contextLimit,
    liveTurn?.contextModel,
    liveTurn?.contextBreakdown,
  ]);

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

  const trailing = useMemo(() => {
    if (!liveWindowActive || !liveTurn) return [];
    const liveItems = buildLiveTurnItems(liveTurn, lane, onSelectNode);
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
    anchorTo: 'end',
    scrollEndThreshold: 80,
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = compensateAboveViewportResize;

  pinRef.current = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= el.clientHeight) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
    requestAnimationFrame(() => {
      const e = scrollRef.current;
      if (e) e.scrollTop = e.scrollHeight;
    });
  };

  const virtualItems = virtualizer.getVirtualItems();

  const premeasureEnabled = isTouch && items.length >= PREMEASURE_MIN_ROWS;
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
          <PendingZone jobId={jobRef.jobId} threadId={threadId} />
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

export function buildLogItems(
  log: JobMessage[],
  jobRef: JobRef,
  opts: {
    lane?: string;
    outstandingRetryTs?: string | null;
    onOpenPlan?: () => void;
    onSelectNode?: (node: string) => void;
  } = {},
): LogItem[] {
  const { lane = MAIN_LANE, outstandingRetryTs = null, onOpenPlan, onSelectNode } = opts;
  const nodes: LogItem[] = [];
  let pending: Array<{ key: string; tool: ToolItem }> = [];

  const sub = indexDurableSubagents(log);
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
    if (isCodexLane) {
      if (!codex.childKeys.has(message.ts)) continue;
    } else {
      if (sub.childKeys.has(message.ts)) continue;
      if (sub.anchorKeys.has(message.ts)) {
        pushSubagentCard(message);
        continue;
      }
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

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/g;
const CODE_FENCE = /```(\w*)\n([\s\S]*?)```/g;
const MERMAID_CHROME_PX = 64;
const CODE_LINE_PX = 19;
const CODE_CHROME_PX = 28;
const CHARS_PER_LINE = 92;
const LINE_PX = 22;

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

const ROW_ESTIMATE_FALLBACK = 112;

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

function estimateForKind(kind: string): number {
  return ROW_ESTIMATE[kind] ?? ROW_ESTIMATE_FALLBACK;
}

interface LogItem {
  key: string;
  node: React.ReactNode;
  estimate: number;
}

function toolGroupEstimate(_toolCount: number): number {
  return 40;
}

const TEXT_KINDS = new Set([
  'claude',
  'user',
  'untrusted',
  'system_shared',
  'compaction',
  'system_operator',
]);

function useThreadHalted(jobId: string | null): boolean | undefined {
  const { data: threads } = useAllJobs();
  if (!jobId) return undefined;
  return threads?.find((t) => t.id === jobId)?.halted;
}
