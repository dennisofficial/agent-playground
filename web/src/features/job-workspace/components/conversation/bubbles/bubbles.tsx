'use client';

import { Button } from '@/components/ui/button';
import { type JobMessage, type JobRef } from '@/lib/api/job-api';
import { useRetryJob, useRetryTurn } from '@/lib/api/job-queries';
import {
  formatElapsed,
  retryCountdownSeconds,
  type LiveBlock,
  type LiveTurn,
} from '@/lib/api/job-stream';
import { assertNever } from '@/utils/assert';
import { formatTokens } from '@/utils/org-display';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  CornerDownRight,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Puzzle,
  RefreshCw,
  RotateCw,
  Sparkles,
  UserCheck,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { type EventKind, type SeedType, type SystemTone } from '../../../lib/classify';
import { streamingBlockKeys } from '../../../lib/streaming-caret';
import { SubagentCard, indexLiveSubagents, subagentNode } from '../../../subagents';
import { ToolGroup, segmentToolRun, type ToolItem } from '../../../tool-calls';
import { Markdown } from '../markdown';
import { MessageTime } from './MessageTime';
import { StreamTextBubble } from './StreamTextBubble';
import { ThinkingBlock } from './ThinkingBlock';

export type TimeTone = 'muted' | 'user' | 'thinking' | 'turn';

export const TIME_TONE_COLOR: Record<TimeTone, string> = {
  muted: 'var(--faint)',
  user: 'var(--accent)',
  thinking: 'var(--faint)',
  turn: 'var(--accent-2)',
};

export function UserBubble({
  text,
  time,
  pending = false,
  pendingLabel = 'sending…',
}: {
  text: string;
  time?: string;
  /** Dim the bubble (0.6) and show a status caption instead of the timestamp. */
  pending?: boolean;
  /** The caption shown while `pending`. `'sending…'` (default) = not yet server-acked; the pending zone passes
   *  `'queued · waiting for the model'` for a sent-but-not-yet-consumed message — SAME bubble body either way. */
  pendingLabel?: string;
}) {
  return (
    <div className="group anim-fadeUp flex flex-col items-end gap-1">
      <div
        className="max-w-[92%] wrap-anywhere px-3.25 py-2 text-text transition-opacity"
        style={{
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-line)',
          borderRadius: '13px 13px 4px 13px',
          opacity: pending ? 0.6 : 1,
        }}
      >
        <Markdown>{text}</Markdown>
      </div>
      {pending ? (
        <span className="flex select-none items-center gap-1 pr-0.5 font-mono text-[9.5px] text-faint">
          <Loader2 size={9} className="animate-spin" />
          {pendingLabel}
        </span>
      ) : (
        <MessageTime iso={time} tone="user" align="right" />
      )}
    </div>
  );
}

export function buildLiveTurnItems(
  turn: LiveTurn,
  lane: string,
  onSelectNode?: (node: string) => void,
): Array<{ key: string; node: React.ReactNode; ts: number }> {
  // Collapse runs of consecutive tool blocks into one group; text/thinking break the run.
  const items: Array<{ key: string; node: React.ReactNode; ts: number }> = [];
  let pending: ToolItem[] = [];
  // Parallel to `pending` — each tool block's `emittedAt`, so a flushed group's `ts` is the MIN across its
  // (possibly re-segmented) members.
  let pendingEmittedAt: number[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const emittedAtByKey = new Map(pending.map((t, i) => [t.key, pendingEmittedAt[i]]));
    for (const seg of segmentToolRun(pending)) {
      const ts = Math.min(...seg.map((t) => emittedAtByKey.get(t.key)!));
      items.push({
        key: `tg-${seg[0].key}`,
        node: <ToolGroup tools={seg} />,
        ts,
      });
    }
    pending = [];
    pendingEmittedAt = [];
  };

  // Peel subagent activity out of the live turn: hide its child blocks, render the spawning Task as a card.
  const sub = indexLiveSubagents(turn.blocks as LiveBlock[]);
  // Only the single most-recent open block of each kind carries the streaming caret — a live turn can hold
  // several open blocks at once (interleaved thinking, a re-attached turn's stranded block), and painting a
  // caret on each is the "multiple cursors" bug.
  const streamingKeys = streamingBlockKeys(turn.blocks as LiveBlock[], turn.active);

  for (const b of turn.blocks as LiveBlock[]) {
    if (sub.childKeys.has(b.key)) continue;
    if (b.kind === 'tool' && b.toolId && sub.anchorKeys.has(b.key)) {
      flush();
      const base = sub.summaryById.get(b.toolId);
      if (base) {
        const parentId = base.parentId;
        // Merge this subagent's OWN live occupancy (from the `parentToolUseId`-tagged `usage` frames) so
        // its card renders its own context ring + real model.
        const su = turn.subUsage?.[parentId];
        const summary = su
          ? {
              ...base,
              contextTokens: su.contextTokens,
              contextLimit: su.contextLimit,
              contextModel: su.contextModel,
            }
          : base;
        items.push({
          key: b.key,
          node: (
            <SubagentCard
              summary={summary}
              onOpen={() => onSelectNode?.(subagentNode(lane, parentId))}
            />
          ),
          ts: b.emittedAt,
        });
      }
      continue;
    }
    if (b.kind === 'tool') {
      pending.push({
        key: b.key,
        name: b.name,
        input: b.input,
        result: b.result,
        isError: b.isError,
        superseded: b.superseded,
        structuredPatch: b.structuredPatch as ToolItem['structuredPatch'],
        jitContext: b.jitContext,
        running: !b.done,
      });
      pendingEmittedAt.push(b.emittedAt);
      continue;
    }
    flush();
    if (b.kind === 'text') {
      items.push({
        key: b.key,
        node: (
          <StreamTextBubble
            text={b.text}
            streaming={streamingKeys.has(b.key)}
            onSelectNode={onSelectNode}
          />
        ),
        ts: b.emittedAt,
      });
    } else {
      items.push({
        key: b.key,
        node: <ThinkingBlock text={b.text} streaming={streamingKeys.has(b.key)} />,
        ts: b.emittedAt,
      });
    }
  }
  flush();

  return items;
}

export const TONE_COLOR: Record<SystemTone, string> = {
  ok: 'var(--green)',
  warn: 'var(--red)',
  accent: 'var(--accent)',
  neutral: 'var(--faint)',
};

/** The known `meta.seedType` values — a runtime whitelist (not just the {@link SeedType} type) so an
 *  untrusted/future/legacy value on the wire falls back to the generic pill instead of ever reaching the
 *  exhaustive switch below (`assertNever` there is a compile-time guard, never a runtime one). Mirrors
 *  {@link KNOWN_EVENT_KINDS}. */
export const KNOWN_SEED_TYPES = [
  'reset_verify',
  'compaction',
  'work_owed_nudge',
  'amend_approved_wake',
  'ship_open_pr',
  'request_changes',
  'unblocked_job_wake',
  'follow_up_job_seed',
  'retry_resume_nudge',
  'session_limit_reset_nudge',
  'mcp_approved',
  'mcp_removed',
  'convention_attached',
  'convention_edited',
  'skill_approved',
  'skill_edit_approved',
  'skill_edit_gone',
] as const;

/** Per-{@link SeedType} icon/label/tone for {@link SystemNoticeRow}'s header pill — exhaustive, so a new
 *  internal-seed type fails the build until it's given a presentation here. Mirrors
 *  {@link eventKindPresentation}. */
export function seedTypePresentation(seedType: SeedType): {
  icon: LucideIcon;
  label: string;
  tone: SystemTone;
} {
  switch (seedType) {
    case 'reset_verify':
      return { icon: RotateCw, label: 'Sandbox verified', tone: 'neutral' };
    case 'compaction':
      return { icon: Sparkles, label: 'Compaction', tone: 'accent' };
    case 'work_owed_nudge':
      return { icon: AlertTriangle, label: 'Work owed', tone: 'accent' };
    case 'amend_approved_wake':
      return { icon: UserCheck, label: 'Amend approved', tone: 'ok' };
    case 'ship_open_pr':
      return { icon: GitPullRequest, label: 'PR opened', tone: 'accent' };
    case 'request_changes':
      return {
        icon: MessageSquare,
        label: 'Changes requested',
        tone: 'accent',
      };
    case 'unblocked_job_wake':
      return { icon: RefreshCw, label: 'Unblocked', tone: 'accent' };
    case 'follow_up_job_seed':
      return { icon: CornerDownRight, label: 'Follow-up job', tone: 'accent' };
    case 'retry_resume_nudge':
      return { icon: Loader2, label: 'Retry resumed', tone: 'accent' };
    case 'session_limit_reset_nudge':
      return { icon: RotateCw, label: 'Session limit reset', tone: 'accent' };
    case 'mcp_approved':
      return { icon: CheckCircle2, label: 'MCP approved', tone: 'ok' };
    case 'mcp_removed':
      return { icon: CircleSlash, label: 'MCP removed', tone: 'neutral' };
    case 'convention_attached':
      return { icon: Puzzle, label: 'Convention attached', tone: 'ok' };
    case 'convention_edited':
      return { icon: Wrench, label: 'Convention edited', tone: 'accent' };
    case 'skill_approved':
      return { icon: CheckCircle2, label: 'Skill approved', tone: 'ok' };
    case 'skill_edit_approved':
      return { icon: CheckCircle2, label: 'Skill edit approved', tone: 'ok' };
    case 'skill_edit_gone':
      return {
        icon: CircleSlash,
        label: 'Skill edit discarded',
        tone: 'neutral',
      };
    default:
      return assertNever(seedType);
  }
}

export function reminderLabel(kind: string | undefined): string {
  switch (kind) {
    case 'open_questions':
      return 'open questions';
    case 'awareness':
      return 'pipeline update';
    case 'memory':
      return 'memory';
    case 'context_pressure':
      return 'context pressure';
    case 'leg_handoff':
      return 'session handoff';
    case 'leg_seed':
      return 'session resumed';
    default:
      return 'context added';
  }
}

export function UntrustedBlock({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const source = message.meta?.untrustedSource as string | undefined;
  const severity = message.meta?.severity as string | undefined;
  // The TRUSTED harness wake framing that rode with the fenced lane report. When present it renders as
  // its own neutral block ABOVE the amber fence, so our own instruction never reads as untrusted data.
  const framing = message.meta?.framing as string | undefined;
  const body = message.text ?? '';
  const fullBody = (message.meta?.fullBody as string | undefined) ?? body;
  const label = source ? `untrusted · ${source}` : 'untrusted';
  return (
    <div className="anim-fadeUp flex flex-col self-stretch gap-1.5">
      {framing ? (
        <div
          className="rounded-md border px-3.5 py-2 text-[12px]"
          style={{
            borderColor: 'var(--hair)',
            background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
          }}
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-faint">
            trusted · harness wake
          </div>
          <Markdown>{framing}</Markdown>
        </div>
      ) : null}
      <div
        className="flex flex-col rounded-md border"
        style={{
          borderColor: 'color-mix(in srgb, var(--amber) 34%, transparent)',
          background: 'color-mix(in srgb, var(--amber) 10%, transparent)',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2.5 px-3.5 py-1.5 text-left font-mono text-[10px] text-dim"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: 'var(--amber)' }}
          />
          <span className="shrink-0 uppercase tracking-wide text-faint">{label}</span>
          {severity ? <span className="shrink-0 text-faint">· {severity}</span> : null}
          <span className="min-w-0 flex-1 truncate">{body}</span>
          <ChevronRight
            size={11}
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </button>
        {open ? (
          <div
            className="border-t px-3.5 py-2.5 text-[12px]"
            style={{ borderColor: 'var(--hair)' }}
          >
            <Markdown>{fullBody}</Markdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface TurnMeta {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    model?: string;
  };
  contextTokens?: number | null;
  contextLimit?: number | null;
  /** How long the turn worked, in ms (start→end). Absent on turns from before this shipped. */
  workedMs?: number;
}

function formatCost(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * The end-of-turn line — the turn's timestamp with its detailed token usage (in / out / cache / cost)
 * sitting right beside it, left-aligned like a message timestamp (NOT an isolated full-width divider).
 * Renders the durable `turn_meta` block the brain appends at each turn end.
 */
export function TurnMetaDivider({ message }: { message: JobMessage }) {
  const meta = (message.meta ?? {}) as TurnMeta;
  const u = meta.usage ?? {};
  const parts: string[] = [];
  if (u.inputTokens != null) parts.push(`${formatTokens(u.inputTokens)} in`);
  if (u.outputTokens != null) parts.push(`${formatTokens(u.outputTokens)} out`);
  if (u.cacheReadTokens) parts.push(`${formatTokens(u.cacheReadTokens)} cache`);
  if (u.costUsd != null) parts.push(formatCost(u.costUsd));
  if (typeof meta.workedMs === 'number' && meta.workedMs > 0)
    parts.push(`worked ${formatElapsed(Math.round(meta.workedMs / 1000))}`);
  return (
    <div className="anim-fadeUp flex items-center gap-1.5 pl-0.5">
      <MessageTime iso={message.postedAt} tone="turn" />
      {parts.length ? (
        <span className="font-mono text-[9.5px] tabular-nums text-faint">
          · {parts.join(' · ')}
        </span>
      ) : null}
    </div>
  );
}

export function useRetryCountdown(targetMs: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (targetMs == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [targetMs]);
  return retryCountdownSeconds(targetMs, now);
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function useResumeCountdown(resumeAt: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!resumeAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resumeAt]);

  if (!resumeAt) return 'auto-resumes at reset';
  const resetMs = new Date(resumeAt).getTime();
  if (!Number.isFinite(resetMs)) return 'auto-resumes at reset';
  const remaining = resetMs - now;
  if (remaining <= 0) return 'auto-resuming…';
  return `auto-resumes in ${formatRemaining(remaining)}`;
}

/** Humanize `meta.category` (a `TurnFailureCategory`) into the short label the header-strip badge shows.
 *  `undefined`/`'unknown'` renders no badge — an unclassified category isn't informative on its own. */
export function humanizeFailureCategory(category: string | undefined): string | undefined {
  switch (category) {
    case 'session_limit':
      return 'Session limit';
    case 'auth':
      return 'Login';
    case 'transient':
      return 'Reconnecting';
    case 'api_overloaded':
      return 'Overloaded';
    case 'sandbox_lost':
      return 'Sandbox lost';
    case 'unresumable':
      return 'Unresumable';
    default:
      return undefined;
  }
}

export function SessionLimitActions({
  jobRef,
  isMain,
  resumeAt,
}: {
  jobRef: JobRef;
  isMain: boolean;
  resumeAt: string | undefined;
}) {
  const retryTurn = useRetryTurn(jobRef);
  const retryJob = useRetryJob(jobRef);
  const resume = isMain ? retryTurn : retryJob;
  const countdown = useResumeCountdown(resumeAt);

  return (
    <div
      className="flex items-center gap-2 border-t px-3.5 py-2.5"
      style={{ borderColor: 'var(--red-line)' }}
    >
      <Button
        size="sm"
        loading={resume.isPending}
        loadingText="Resuming…"
        disabled={resume.isSuccess}
        onClick={() => resume.mutate({ force: true })}
      >
        <RotateCw size={12} className="mr-1" />
        {resume.isSuccess ? 'Resumed' : 'Force resume now'}
      </Button>
      <span className="text-dim text-[11.5px]">{countdown}</span>
      {resume.isError ? (
        <span className="text-[11.5px] text-red">Couldn&apos;t resume. Try again.</span>
      ) : null}
    </div>
  );
}

/** The known `meta.eventKind` values — a runtime whitelist (not just the {@link EventKind} type) so an
 *  untrusted/future value on the wire falls back to the generic panel instead of ever reaching the
 *  exhaustive switch below (`assertNever` there is a compile-time guard, never a runtime one). */
export const KNOWN_EVENT_KINDS = [
  'ci_failure',
  'review_changes_requested',
  'review_approved',
  'review_comment',
] as const;

/** Per-{@link EventKind} icon/label/tone for {@link EventBubble}'s header — exhaustive, so a new event kind
 *  fails the build until it's given a presentation here. */
export function eventKindPresentation(eventKind: EventKind): {
  icon: LucideIcon;
  label: string;
  tone: SystemTone;
} {
  switch (eventKind) {
    case 'ci_failure':
      return { icon: XCircle, label: 'CI failed', tone: 'warn' };
    case 'review_changes_requested':
      return { icon: AlertTriangle, label: 'Changes requested', tone: 'warn' };
    case 'review_approved':
      return { icon: CheckCircle2, label: 'Review approved', tone: 'ok' };
    case 'review_comment':
      return { icon: MessageSquare, label: 'Review comment', tone: 'accent' };
    default:
      return assertNever(eventKind);
  }
}
