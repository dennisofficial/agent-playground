'use client';

import { useMemo, useState } from 'react';
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
import { SubagentCard, indexDurableSubagents, subagentNode } from './subagents';
import { BuildStepCard, indexPhaseBlocks } from './phases';
import { Composer } from './composer';
import { DetailTopBar } from './detail-top-bar';
import type { JobMessage, JobRef } from '@/lib/api/thread-api';
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
  threadRef: JobRef;
  messages: JobMessage[];
  isLoading: boolean;
  live: boolean;
  onOpenPlan?: () => void;
  /** Open a node in the right detail pane (e.g. a subagent run's sub-page). */
  onSelectNode?: (node: string) => void;
}) {
  // The composer is a floating overlay; track its height so the transcript reserves matching space and
  // the last line never slips under it as the box auto-grows.
  const [composerHeight, setComposerHeight] = useState(116);
  const liveTurn = useLiveTurn(threadRef.jobId);
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
  const queuedTexts = useQueuedSends(threadRef.jobId);
  const isQueued = (m: JobMessage): boolean =>
    m.author === 'user' && turnActive && (m.queued === true || queuedTexts.has(m.text));
  const log = messages.filter((m) => !isQueued(m));
  const queued = messages.filter(isQueued);

  // The context-window ring reads the MOST RECENT `turn_meta` block (the brain appends one per turn with
  // the last request's occupancy + the model's window). Refreshes each turn end via the durable refetch.
  const contextMeta = useMemo(() => latestContextMeta(messages), [messages]);

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
        <Composer threadRef={threadRef} onHeightChange={setComposerHeight} context={contextMeta} />
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
  log: JobMessage[],
  threadRef: JobRef,
  onOpenPlan?: () => void,
  onSelectNode?: (node: string) => void,
): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let pending: Array<{ key: string; tool: ToolItem }> = [];

  // Subagent activity is peeled out: its child blocks are hidden from the main log, and the spawning Task
  // block renders as a card (opens the run's sub-page) instead of as a row in a tool group.
  const sub = indexDurableSubagents(log);
  // Build-phase activity is peeled out the same way: a phase's blocks are hidden, and its `build_anchor`
  // row renders as a `BuildStepCard` (opens the step sub-page).
  const phase = indexPhaseBlocks(log);

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
    // A block produced BY a build phase — lives in the step sub-page, not the main conversation.
    if (phase.childKeys.has(message.ts)) continue;
    // The synthetic `build_anchor` row — render its card (flush any open tool run first).
    if (phase.anchorKeys.has(message.ts)) {
      flush();
      const phaseId = typeof message.meta?.phaseId === 'string' ? message.meta.phaseId : '';
      const anchor = phase.anchorByPhase.get(phaseId);
      if (anchor)
        nodes.push(
          <BuildStepCard
            key={message.ts}
            jobId={threadRef.jobId}
            anchor={anchor}
            durableToolCount={(phase.blocksByPhase.get(phaseId) ?? []).filter((m) => m.kind === 'tool').length}
            onOpen={() => onSelectNode?.(phaseId)}
          />,
        );
      continue;
    }
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

    // A per-turn accounting block (token usage + context occupancy) — rendered as a turn-end divider.
    // Handled raw, BEFORE classifyMessage (which would otherwise fall this unknown kind through to a
    // plain Claude bubble). Flush any open tool run first so the divider lands after the turn's tools.
    if (message.kind === 'turn_meta') {
      flush();
      nodes.push(<TurnMetaDivider key={message.ts} message={message} />);
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

    switch (c.kind) {
      case 'user':
        nodes.push(<UserBubble key={message.ts} text={message.text} time={message.postedAt} />);
        break;
      case 'thinking':
        nodes.push(<ThinkingBlock key={message.ts} text={message.text} time={message.postedAt} />);
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
      case 'secret':
        nodes.push(<SecretCardView key={message.ts} card={c.card} threadRef={threadRef} />);
        break;
      case 'event':
        nodes.push(<SystemEventPill key={message.ts} message={message} tone={c.tone} />);
        break;
      case 'system_shared':
        nodes.push(<HarnessBubble key={message.ts} message={message} />);
        break;
      case 'system_event':
        nodes.push(<EventBubble key={message.ts} message={message} />);
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
  return <DetailTopBar title="Conversation" subtitle="the thread brain" />;
}
