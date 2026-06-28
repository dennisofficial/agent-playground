'use client';

import { useState } from 'react';
import { classifyMessage } from './classify';
import { JumpToLatestButton, useTailFollow } from './tail-follow';
import {
  ClaudeBubble,
  HarnessBubble,
  LiveIndicator,
  LiveTurnView,
  SystemEventPill,
  SystemOperatorNotice,
  ThinkingBlock,
  UserBubble,
} from './bubbles';
import { ToolGroup, segmentToolRun, type ToolItem } from './tool-calls';
import { ApprovalCardView, VerdictCardView } from './approval-card';
import { QuestionCardView } from './question-card';
import { SubagentCard, indexDurableSubagents, subagentNode } from './subagents';
import { Composer } from './composer';
import type { ThreadMessage, ThreadRef } from '@/lib/api/thread-api';
import { useLiveTurn } from '@/lib/api/thread-stream';
import { useQueuedSends } from '@/lib/api/queued-sends';

/**
 * Conversation mode — the thread's brain. One continuous session: intent, planning, and steering all
 * live here. A centered 760px column of typed bubbles + the composer.
 */
export function Conversation({
  threadRef,
  messages,
  isLoading,
  live,
  onOpenPlan,
  onSelectNode,
}: {
  threadRef: ThreadRef;
  messages: ThreadMessage[];
  isLoading: boolean;
  live: boolean;
  onOpenPlan?: () => void;
  /** Open a node in the right detail pane (e.g. a subagent run's sub-page). */
  onSelectNode?: (node: string) => void;
}) {
  // The composer is a floating overlay; track its height so the transcript reserves matching space and
  // the last line never slips under it as the box auto-grows.
  const [composerHeight, setComposerHeight] = useState(116);
  const liveTurn = useLiveTurn(threadRef.threadId);
  const liveBlockCount = liveTurn?.blocks.length ?? 0;
  const turnActive = liveTurn?.active ?? false;
  // Stream signature — grows with streaming text/thinking so the tail follows token-by-token, not just on
  // block boundaries (mirrors the subagent run view).
  const liveStreamSig = (liveTurn?.blocks ?? []).reduce(
    (n, b) => n + (b.kind === 'tool' ? 1 : b.text.length),
    0,
  );

  // Messages sent while a turn is streaming are QUEUED behind it (the brain serializes turns per thread).
  // Pull them out of the main log and render them below the live response with a "queued" treatment — so
  // a follow-up reads as "waiting its turn", not as an already-answered message in the wrong spot.
  const queuedTexts = useQueuedSends(threadRef.threadId);
  const isQueued = (m: ThreadMessage): boolean =>
    m.author === 'user' && turnActive && (m.queued === true || queuedTexts.has(m.text));
  const log = messages.filter((m) => !isQueued(m));
  const queued = messages.filter(isQueued);

  const { scrollRef, endRef, showJump, jumpToLatest, onScroll } = useTailFollow([
    messages.length,
    live,
    liveBlockCount,
    liveStreamSig,
    turnActive,
    queued.length,
    composerHeight,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <ConversationTopBar />
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-7 pt-5">
          <div className="mx-auto flex max-w-[880px] flex-col gap-[9px]">
          {isLoading && messages.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">Loading conversation…</p>
          ) : messages.length === 0 && liveBlockCount === 0 ? (
            <p className="py-10 text-center text-[13px] text-faint">
              No messages yet — say something to Atlas below.
            </p>
          ) : (
            renderLog(log, threadRef, onOpenPlan, onSelectNode)
          )}
          {liveTurn && liveBlockCount > 0 ? <LiveTurnView turn={liveTurn} onSelectNode={onSelectNode} /> : null}
          {live || turnActive ? <LiveIndicator /> : null}
          {queued.map((message) => (
            <UserBubble key={message.ts} text={message.text} queued />
          ))}
            {/* Spacer so the last line clears the floating composer when scrolled to the bottom.
                Tracks the composer's live height so it grows with the auto-expanding box. */}
            <div className="shrink-0" style={{ height: composerHeight }} aria-hidden />
            <div ref={endRef} />
          </div>
        </div>
        {showJump ? <JumpToLatestButton onClick={jumpToLatest} style={{ bottom: composerHeight + 8 }} /> : null}
        <Composer threadRef={threadRef} onHeightChange={setComposerHeight} />
      </div>
    </div>
  );
}

/**
 * Render the durable transcript, collapsing runs of consecutive tool messages into `ToolGroup`s
 * (file-edits split into their own "N files changed" group via {@link segmentToolRun}) while every
 * other kind renders as its own typed block.
 */
function renderLog(
  log: ThreadMessage[],
  threadRef: ThreadRef,
  onOpenPlan?: () => void,
  onSelectNode?: (node: string) => void,
): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let pending: Array<{ key: string; tool: ToolItem }> = [];

  // Subagent activity is peeled out: its child blocks are hidden from the main log, and the spawning Task
  // block renders as a card (opens the run's sub-page) instead of as a row in a tool group.
  const sub = indexDurableSubagents(log);

  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending.map((p) => p.tool))) {
      nodes.push(<ToolGroup key={`tg-${seg[0].key}`} tools={seg} />);
    }
    pending = [];
  };

  for (const message of log) {
    // A block produced BY a subagent — lives in the sub-page, not the main conversation.
    if (sub.childKeys.has(message.ts)) continue;
    // The Task block that spawned a subagent — render its card (flush any open tool run first).
    if (sub.anchorKeys.has(message.ts)) {
      flush();
      const summary = sub.summaryById.get(String(message.meta?.id));
      if (summary)
        nodes.push(
          <SubagentCard
            key={message.ts}
            summary={summary}
            onOpen={() => onSelectNode?.(subagentNode(summary.parentId))}
          />,
        );
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
        },
      });
      continue;
    }
    flush();

    switch (c.kind) {
      case 'user':
        nodes.push(<UserBubble key={message.ts} text={message.text} />);
        break;
      case 'thinking':
        nodes.push(<ThinkingBlock key={message.ts} text={message.text} />);
        break;
      case 'approval':
        nodes.push(<ApprovalCardView key={message.ts} card={c.card} threadRef={threadRef} onOpenPlan={onOpenPlan} />);
        break;
      case 'verdict':
        nodes.push(<VerdictCardView key={message.ts} card={c.card} />);
        break;
      case 'question':
        nodes.push(<QuestionCardView key={message.ts} card={c.card} threadRef={threadRef} />);
        break;
      case 'event':
        nodes.push(<SystemEventPill key={message.ts} message={message} tone={c.tone} />);
        break;
      case 'system_shared':
        nodes.push(<HarnessBubble key={message.ts} message={message} />);
        break;
      case 'system_operator':
        nodes.push(<SystemOperatorNotice key={message.ts} message={message} />);
        break;
      case 'claude':
      default:
        nodes.push(<ClaudeBubble key={message.ts} message={message} />);
        break;
    }
  }
  flush();

  return nodes;
}

/**
 * The conversation top bar — a `CONVERSATION` label plus search / copy-transcript / view-diff / resume
 * shortcuts. The action buttons are static design-parity placeholders for now (no backend wiring).
 */
function ConversationTopBar() {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3.5">
      <span className="min-w-0 flex-1 font-mono text-[9px] tracking-[0.16em] text-faint">CONVERSATION</span>
      <div className="flex items-center gap-0.5">
        <TopBarButton title="Search this thread">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </TopBarButton>
        <TopBarButton title="Copy transcript">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </TopBarButton>
        <button
          type="button"
          title="View diff · 4 files"
          className="flex h-[29px] items-center gap-1.5 rounded-sm px-2.5 text-dim transition hover:bg-surface-2 hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v14" />
            <path d="M5 10h14" />
            <path d="M5 21h14" />
          </svg>
          <span className="font-mono text-[10px]">4</span>
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
        <TopBarButton title="Resume / step the run">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M6 4l14 8-14 8z" />
          </svg>
        </TopBarButton>
      </div>
    </div>
  );
}

function TopBarButton({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      className="flex h-[29px] w-[29px] items-center justify-center rounded-sm text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  );
}
