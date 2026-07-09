"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Loader2, RotateCw } from "lucide-react";
import { toneOf, type SystemTone } from "./classify";
import { Markdown } from "./markdown";
import { ToolGroup, segmentToolRun, type ToolItem } from "./tool-calls";
import { SubagentCard, indexLiveSubagents, subagentNode } from "./subagents";
import { Button } from "@/components/ui/button";
import { useRetryTurn } from "@/lib/api/job-queries";
import type { JobMessage, JobRef } from "@/lib/api/job-api";
import {
  formatElapsed,
  summarizeLiveTurn,
  useElapsedSeconds,
  type LiveBlock,
  type LiveTurn,
} from "@/lib/api/job-stream";
import { formatClockTime, formatTokens } from "@/lib/org-display";

/** Per-type tone for {@link MessageTime} — distinct colors so the operator can tell turn boundaries from
 *  in-turn blocks at a glance (the user wants to eyeball density/color before we tune it down). */
export type TimeTone = "muted" | "user" | "thinking" | "turn";

const TIME_TONE_COLOR: Record<TimeTone, string> = {
  muted: "var(--faint)",
  user: "var(--accent)",
  thinking: "var(--faint)",
  turn: "var(--accent-2)",
};

/**
 * A small, muted timestamp shown beside a conversation block. `tone` colors it by message type. Always
 * rendered for now so the operator can judge the density; flip an individual call site to `hoverOnly`
 * (reveals on parent `.group` hover) once we decide which types should be quiet — a one-prop change.
 */
export function MessageTime({
  iso,
  tone = "muted",
  align = "left",
  hoverOnly = false,
}: {
  iso?: string;
  tone?: TimeTone;
  align?: "left" | "right";
  hoverOnly?: boolean;
}) {
  if (!iso) return null;
  const label = formatClockTime(iso);
  if (!label) return null;
  return (
    <span
      className={`select-none font-mono text-[9.5px] tabular-nums tracking-[0.04em] ${align === "right" ? "self-end pr-0.5" : "pl-0.5"} ${hoverOnly ? "opacity-0 transition-opacity group-hover:opacity-100" : "opacity-70"}`}
      style={{ color: TIME_TONE_COLOR[tone] }}
      title={new Date(iso).toLocaleString()}
    >
      {label}
    </span>
  );
}

/** Small Atlas/Claude avatar — the brand mark, mini (the rotated rounded square). */
export function ClaudeAvatar({ size = 24 }: { size?: number }) {
  const inner = Math.round(size * 0.38);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(145deg, var(--accent), var(--accent-2))",
      }}
      aria-hidden
    >
      <span
        style={{
          width: inner,
          height: inner,
          transform: "rotate(45deg)",
          border: "1.5px solid rgba(255,255,255,0.92)",
          borderRadius: 2,
        }}
      />
    </span>
  );
}

/**
 * An operator message — the right-aligned accent bubble. Takes raw `text` (not a `JobMessage`) so it can
 * stand in for any operator-authored instruction, including a subagent's Task prompt (the "user message"
 * that kicked the run off), rendered identically to the main transcript.
 */
export function UserBubble({
  text,
  time,
  pending = false,
}: {
  text: string;
  time?: string;
  /** True for an optimistic (`local`) message not yet echoed by the server — dims the bubble and shows a
   *  "sending…" indicator until the durable row lands and replaces it. */
  pending?: boolean;
}) {
  return (
    <div className="group anim-fadeUp flex flex-col items-end gap-1">
      <div
        className="max-w-[92%] [overflow-wrap:anywhere] px-[13px] py-2 text-text transition-opacity"
        style={{
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-line)",
          borderRadius: "13px 13px 4px 13px",
          opacity: pending ? 0.6 : 1,
        }}
      >
        <Markdown>{text}</Markdown>
      </div>
      {pending ? (
        <span className="flex select-none items-center gap-1 pr-0.5 font-mono text-[9.5px] text-faint">
          <Loader2 size={9} className="animate-spin" />
          sending…
        </span>
      ) : (
        <MessageTime iso={time} tone="user" align="right" />
      )}
    </div>
  );
}

export function ClaudeBubble({ message }: { message: JobMessage }) {
  // No per-bubble timestamp on assistant prose — the end-of-turn `TurnMetaDivider` line carries the
  // turn's time (next to its token counter), so a timestamp here would just duplicate it.
  return <StreamTextBubble text={message.text} />;
}

/**
 * An assistant message — rendered as markdown prose (no avatar, no bubble), per the conversation redesign.
 * `streaming` adds a blinking cursor for the live (token-by-token) turn.
 */
export function StreamTextBubble({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="anim-fadeUp">
      <Markdown>{text}</Markdown>
      {streaming ? (
        <span
          className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse"
          style={{ background: "var(--accent)" }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

/** A collapsible thinking block (the model's reasoning) — dimmed + italic, like Claude Code. */
export function ThinkingBlock({
  text,
  streaming = false,
  time,
}: {
  text: string;
  streaming?: boolean;
  time?: string;
}) {
  // Auto-expand while the reasoning is streaming (watch it think live), then collapse it once the turn
  // finishes so the transcript stays tidy. Manual toggles between streaming-state changes are preserved —
  // the effect only re-fires when `streaming` itself flips. Persisted blocks render with streaming=false → closed.
  const [open, setOpen] = useState(streaming);
  useEffect(() => setOpen(streaming), [streaming]);
  return (
    <div className="anim-fadeUp">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-left font-mono text-[11px] italic text-faint hover:text-dim"
        >
          <ChevronRight
            size={11}
            strokeWidth={2.6}
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {streaming ? "thinking…" : "thought"}
        </button>
        <MessageTime iso={time} tone="thinking" />
      </div>
      {open ? (
        <p
          className="mt-1.5 whitespace-pre-wrap pl-[18px] text-[12.5px] italic leading-relaxed text-dim"
          style={{ borderLeft: "2px solid var(--border)" }}
        >
          {/* trim: summarized thinking arrives with leading/trailing newlines that whitespace-pre-wrap
              would otherwise render as blank-line padding above the text; internal formatting is preserved. */}
          {text.trim()}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Builds the render items for a thread's in-flight LIVE turn (token-streamed text, thinking, and grouped
 * tool calls), each stamped with a `ts` (epoch ms) so a caller can time-merge them against durable rows
 * that arrive mid-turn. See {@link LiveTurnView}, the thin standalone-rendering wrapper around this.
 */
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
    const emittedAtByKey = new Map(
      pending.map((t, i) => [t.key, pendingEmittedAt[i]]),
    );
    for (const seg of segmentToolRun(pending)) {
      const ts = Math.min(...seg.map((t) => emittedAtByKey.get(t.key)!));
      items.push({ key: `tg-${seg[0].key}`, node: <ToolGroup tools={seg} />, ts });
    }
    pending = [];
    pendingEmittedAt = [];
  };

  // Peel subagent activity out of the live turn: hide its child blocks, render the spawning Task as a card.
  const sub = indexLiveSubagents(turn.blocks as LiveBlock[]);

  for (const b of turn.blocks as LiveBlock[]) {
    if (sub.childKeys.has(b.key)) continue;
    if (b.kind === "tool" && b.toolId && sub.anchorKeys.has(b.key)) {
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
    if (b.kind === "tool") {
      pending.push({
        key: b.key,
        name: b.name,
        input: b.input,
        result: b.result,
        isError: b.isError,
        structuredPatch: b.structuredPatch as ToolItem["structuredPatch"],
        running: !b.done,
      });
      pendingEmittedAt.push(b.emittedAt);
      continue;
    }
    flush();
    if (b.kind === "text") {
      items.push({
        key: b.key,
        node: (
          <StreamTextBubble text={b.text} streaming={!b.done && turn.active} />
        ),
        ts: b.emittedAt,
      });
    } else {
      items.push({
        key: b.key,
        node: (
          <ThinkingBlock text={b.text} streaming={!b.done && turn.active} />
        ),
        ts: b.emittedAt,
      });
    }
  }
  flush();

  return items;
}

/** Render a thread's in-flight LIVE turn (token-streamed text, thinking, and grouped tool calls). */
export function LiveTurnView({
  turn,
  lane,
  onSelectNode,
}: {
  turn: LiveTurn;
  /** The lane `turn` is streaming on — baked into any subagent card's node so its pane subscribes to the
   *  right live turn (see {@link subagentNode}). */
  lane: string;
  onSelectNode?: (node: string) => void;
}) {
  return (
    <>
      {buildLiveTurnItems(turn, lane, onSelectNode).map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
    </>
  );
}

const TONE_COLOR: Record<SystemTone, string> = {
  ok: "var(--green)",
  warn: "var(--red)",
  accent: "var(--accent)",
  neutral: "var(--faint)",
};

export function SystemEventPill({
  message,
  tone,
}: {
  message: JobMessage;
  tone: SystemTone;
}) {
  return (
    <div
      className="anim-fadeUp flex items-center gap-2.5 self-stretch rounded-md border px-3.5 py-1.5 font-mono text-[10px] text-dim"
      style={{
        borderColor: "var(--hair)",
        background: "color-mix(in srgb, var(--surface-2) 70%, transparent)",
      }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: TONE_COLOR[tone] }}
      />
      <span className="truncate">{message.text}</span>
    </div>
  );
}

/**
 * A session-compaction pill — renders like {@link SystemEventPill}, but the message carries the full handoff
 * summary (what context was kept when the brain session was compacted). Click to expand and inspect it. The
 * summary lives durably on the message row, so it stays auditable for the life of the job.
 */
export function CompactionSummaryPill({
  message,
  tone,
  summary,
}: {
  message: JobMessage;
  tone: SystemTone;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="anim-fadeUp flex flex-col self-stretch rounded-md border"
      style={{
        borderColor: "var(--hair)",
        background: "color-mix(in srgb, var(--surface-2) 70%, transparent)",
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
          style={{ background: TONE_COLOR[tone] }}
        />
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
        <span className="shrink-0 text-faint">{open ? "hide" : "inspect"}</span>
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div
          className="border-t px-3.5 py-2.5 text-[12px]"
          style={{ borderColor: "var(--hair)" }}
        >
          <Markdown>{summary}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A harness-injected `system_notice` — a durable state change the brain was told about inline (sandbox
 * reset, secret/file confirmation). Renders as a collapsed one-line muted row (dot + truncated text);
 * click to expand the full body (reset notices run several sentences). NOT an operator or Atlas bubble.
 */
export function SystemNoticeRow({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const tone = toneOf(message.text ?? "");
  return (
    <div
      className="anim-fadeUp flex flex-col self-stretch rounded-md border"
      style={{
        borderColor: "var(--hair)",
        background: "color-mix(in srgb, var(--surface-2) 70%, transparent)",
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
          style={{ background: TONE_COLOR[tone] }}
        />
        <span className="shrink-0 uppercase tracking-wide text-faint">
          system
        </span>
        <span className="min-w-0 flex-1 truncate">{message.text}</span>
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div
          className="border-t px-3.5 py-2.5 text-[12px]"
          style={{ borderColor: "var(--hair)" }}
        >
          <Markdown>{message.text}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/** Human-readable label for a `system_reminder`'s `meta.reminderKind`. */
function reminderLabel(kind: string | undefined): string {
  switch (kind) {
    case "open_questions":
      return "open questions";
    case "awareness":
      return "pipeline update";
    case "memory":
      return "memory";
    case "context_pressure":
      return "context pressure";
    case "leg_handoff":
      return "session handoff";
    case "leg_seed":
      return "session resumed";
    default:
      return "context added";
  }
}

/**
 * A harness-injected `system_reminder` — context that rode ALONGSIDE the turn it precedes (pipeline
 * awareness, open-questions, a memory hit). Renders as a compact, right-aligned chip (so it associates
 * with the user bubble that follows it in the transcript); click to expand the exact injected text.
 */
export function SystemReminderChip({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const label = reminderLabel(
    message.meta?.reminderKind as string | undefined,
  );
  return (
    <div className="anim-fadeUp flex flex-col items-end gap-1 self-stretch">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim"
        style={{
          borderColor: "var(--hair)",
          background: "color-mix(in srgb, var(--surface-2) 60%, transparent)",
        }}
      >
        <span
          className="h-1 w-1 rounded-full"
          style={{ background: "var(--dim)" }}
        />
        harness · {label}
      </button>
      {open ? (
        <div
          className="max-w-[92%] rounded-md border px-3 py-2 text-[12px] text-dim"
          style={{
            borderColor: "var(--hair)",
            background: "color-mix(in srgb, var(--surface-2) 60%, transparent)",
          }}
        >
          <Markdown>{message.text}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A durable `untrusted` row — external, untrusted data that was folded into a turn (an event/webhook body,
 * a halted build thread's own record). Renders as a muted, amber-tinted disclosure labeled `untrusted ·
 * {source}` so it reads as DATA, not operator/atlas prose. Provenance + severity ride in `meta`.
 */
export function UntrustedBlock({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const source = message.meta?.untrustedSource as string | undefined;
  const severity = message.meta?.severity as string | undefined;
  const body = message.text ?? "";
  const label = source ? `untrusted · ${source}` : "untrusted";
  return (
    <div
      className="anim-fadeUp flex flex-col self-stretch rounded-md border"
      style={{
        borderColor: "color-mix(in srgb, var(--amber) 34%, transparent)",
        background: "color-mix(in srgb, var(--amber) 10%, transparent)",
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
          style={{ background: "var(--amber)" }}
        />
        <span className="shrink-0 uppercase tracking-wide text-faint">
          {label}
        </span>
        {severity ? (
          <span className="shrink-0 text-faint">· {severity}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{body}</span>
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div
          className="border-t px-3.5 py-2.5 text-[12px]"
          style={{ borderColor: "var(--hair)" }}
        >
          <Markdown>{body}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

/** The shape of a `turn_meta` block's `meta` — per-turn token usage + context occupancy (see the brain). */
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
}

/** Format a USD cost: sub-cent as 4dp ($0.0042), otherwise 2dp ($0.03). */
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
  return (
    <div className="anim-fadeUp flex items-center gap-1.5 pl-0.5">
      <MessageTime iso={message.postedAt} tone="turn" />
      {parts.length ? (
        <span className="font-mono text-[9.5px] tabular-nums text-faint">
          · {parts.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

// `ContextMeter` moved to ./context-meter (so `subagents.tsx` can reuse it without a bubbles↔subagents
// import cycle). Re-exported here for existing consumers (e.g. composer.tsx imports it from ./bubbles).
export { ContextMeter } from "./context-meter";

/**
 * The "Atlas is working…" indicator. When a live `turn` is supplied it renders a rich, Claude-Code-style
 * status line: `{elapsed} · {N} running task{s} · {statusWord}…` (the "N running task" clause is omitted
 * when there are no open tool calls) — e.g. `25s · 1 running task · still thinking…` or, for longer turns,
 * `19m 24s · 1 running task · using tools…`. `elapsed` ticks every second off the turn's `startedAt` and is
 * formatted compactly (`45s` / `19m 24s` / `1h 05m 24s`); `N` counts in-flight tool calls (tool_use with no tool_result yet,
 * incl. subagent/Task runs); `statusWord` comes from the last live block. Falls back to the plain `text`
 * when no turn is available (e.g. the pipeline-level `live` flag with no live-turn buffer, or a build lane).
 *
 * NOTE: token count is intentionally NOT shown — it's a backend fast-follow that isn't wired yet.
 */
export function LiveIndicator({
  turn,
  text = "Atlas is working…",
}: {
  turn?: LiveTurn;
  text?: string;
}) {
  const elapsed = useElapsedSeconds(turn?.startedAt);
  const { openTools, statusWord } = summarizeLiveTurn(turn);
  const label = !turn
    ? text
    : [
        formatElapsed(elapsed),
        openTools > 0
          ? `${openTools} running task${openTools === 1 ? "" : "s"}`
          : null,
        `${statusWord}…`,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <div className="anim-fadeUp flex items-center gap-2.5 text-[11.5px] text-accent">
      <span
        className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: "var(--accent)",
          boxShadow: "0 0 9px var(--accent)",
        }}
      />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

/**
 * A SYSTEM→OPERATOR notice — a runtime/harness message addressed to the OPERATOR, not authored by Atlas
 * and never seen by it (e.g. "this thread can't be resumed — start a new one"). Deliberately NOT an Atlas
 * bubble: a full-width warn-toned panel with a "SYSTEM" header so it reads as coming from the harness.
 * When `meta.retryable` is set (a transient engine failure, not a terminal one), a "Resume" button
 * re-pokes the SAME engine session (`POST …/retry-turn`) with no new operator-authored message.
 */
export function SystemOperatorNotice({
  message,
  jobRef,
}: {
  message: JobMessage;
  jobRef: JobRef;
}) {
  const retryable = message.meta?.retryable === true;
  const retry = useRetryTurn(jobRef);
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{ borderColor: "var(--red-line)", background: "var(--red-soft)" }}
    >
      {/* Header strip */}
      <div
        className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
        style={{
          borderBottom: "1px solid var(--red-line)",
          background: "color-mix(in srgb, var(--red) 10%, transparent)",
        }}
      >
        <span
          aria-hidden
          style={{ color: "var(--red)", fontSize: 11, lineHeight: 1 }}
        >
          ⚠
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--red)" }}
        >
          System
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint">harness</span>
      </div>
      {/* Markdown body */}
      <div className="px-3.5 py-3">
        <Markdown>{message.text}</Markdown>
      </div>
      {retryable ? (
        <div
          className="flex items-center gap-2 border-t px-3.5 py-2.5"
          style={{ borderColor: "var(--red-line)" }}
        >
          <Button
            size="sm"
            loading={retry.isPending}
            loadingText="Resuming…"
            disabled={retry.isSuccess}
            onClick={() => retry.mutate()}
          >
            <RotateCw size={12} className="mr-1" />
            {retry.isSuccess ? "Resumed" : "Resume"}
          </Button>
          {retry.isError ? (
            <span className="text-[11.5px] text-red">
              Couldn&apos;t resume. Try again.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A harness-injected review block (e.g. Codex plan-review findings — `source='system_shared'`, seen by
 * both the operator and Atlas). Visually distinct from both operator bubbles (right-aligned) and Atlas
 * prose (plain markdown): a full-width bordered panel with a small labelled header and the markdown body.
 */
export function HarnessBubble({ message }: { message: JobMessage }) {
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{
        borderColor: "var(--border-2)",
        background: "color-mix(in srgb, var(--surface-2) 60%, transparent)",
      }}
    >
      {/* Header strip */}
      <div
        className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
        style={{
          borderBottom: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--surface-3) 70%, transparent)",
        }}
      >
        {/* Small "codex" logo — a diamond/square rotated 45°, echoing the ClaudeAvatar shape */}
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px]"
          style={{ background: "var(--dim)" }}
          aria-hidden
        >
          <span
            style={{
              display: "block",
              width: 6,
              height: 6,
              transform: "rotate(45deg)",
              border: "1.5px solid rgba(255,255,255,0.85)",
              borderRadius: 1,
            }}
          />
        </span>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-dim">
          Codex review
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-faint">
          {message.authorName}
        </span>
      </div>
      {/* Markdown body */}
      <div className="px-3.5 py-3">
        <Markdown>{message.text}</Markdown>
      </div>
    </div>
  );
}

/**
 * An automated NOTIFICATION that opened this thread (`source='system_event'`) — a GitHub/CI/webhook event
 * delivered to Atlas as a harness message and shown to the operator. Distinct from operator bubbles, Atlas
 * prose, and the (neutral) Codex `HarnessBubble`: a full-width accent-toned panel whose header names the
 * source + severity (read off `meta.eventSource` / `meta.severity`), so it reads as "not human-sent."
 */
export function EventBubble({ message }: { message: JobMessage }) {
  const meta = message.meta ?? {};
  const source =
    typeof meta.eventSource === "string" ? meta.eventSource : "event";
  const severity = typeof meta.severity === "string" ? meta.severity : null;
  return (
    <div
      className="anim-fadeUp rounded-[9px] border"
      style={{
        borderColor: "var(--accent-line)",
        background: "var(--accent-soft)",
      }}
    >
      {/* Header strip */}
      <div
        className="flex items-center gap-2 rounded-t-[8px] px-3.5 py-2"
        style={{
          borderBottom: "1px solid var(--accent-line)",
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
        }}
      >
        <span
          aria-hidden
          style={{ color: "var(--accent)", fontSize: 11, lineHeight: 1 }}
        >
          ◈
        </span>
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--accent)" }}
        >
          Event · {source}
        </span>
        <span className="flex-1" />
        {severity ? (
          <span className="font-mono text-[10px] text-faint">{severity}</span>
        ) : null}
      </div>
      {/* Markdown body */}
      <div className="px-3.5 py-3">
        <Markdown>{message.text}</Markdown>
      </div>
    </div>
  );
}
