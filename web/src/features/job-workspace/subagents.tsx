"use client";

import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { JobMessage } from "@/lib/api/job-api";
import type { LiveBlock } from "@/lib/api/job-stream";
import { formatModelLabel } from "@/lib/format";
import { ContextMeter } from "./context-meter";

/**
 * Subagent (Task) activity is peeled OUT of the main conversation and rendered as its own node/sub-page.
 *
 * The join: every block a subagent produces carries `meta.parentToolUseId` (the SDK's `parent_tool_use_id`)
 * equal to the spawning Task block's own id (persisted as `meta.id`). So a tool block whose `meta.id` is
 * referenced by some other block's `meta.parentToolUseId` is the ANCHOR; everything pointing at it is its
 * transcript. The main log renders the anchor as a compact card; the transcript lives in the detail pane.
 *
 * This module stays free of `./bubbles` imports so `bubbles` can import the card without a cycle; the full
 * transcript renderer (which needs the bubble/tool-call components) lives in `step-view.tsx`.
 */

export const SUBAGENT_NODE_PREFIX = "subagent:";
/** Encodes the ORIGIN lane alongside the parent tool-use id (`<lane>::<parentId>`) — the pane needs the
 *  lane to subscribe to the right live turn; a subagent spawned inside a build thread runs on THAT
 *  thread's lane, not Main, and its blocks are invisible to a lane-unaware subscriber. */
export const subagentNode = (lane: string, parentId: string): string =>
  `${SUBAGENT_NODE_PREFIX}${lane}::${parentId}`;

/** Known subagent types → display model (the engine pins these; mirrors `SUBAGENTS` / `WRITER_SUBAGENTS`
 *  in engine-core.ts). The writer subagents fan out on execute turns: `implement` (Sonnet) is the default
 *  writer for substantial slices, `implement-deep` (Opus) the escalation for judgment-heavy ones. */
const SUBAGENT_MODELS: Record<string, string> = {
  explore: "Sonnet",
  implement: "Sonnet",
  "implement-deep": "Opus",
};
export const subagentModel = (type: string): string | undefined =>
  SUBAGENT_MODELS[type];

/** A normalized transcript block — produced from a durable message OR a live block. `postedAt` is set only
 *  on durable blocks (live blocks have no emission time yet). */
export type SubBlock =
  | {
      kind: "text";
      key: string;
      text: string;
      running?: boolean;
      postedAt?: string;
    }
  | {
      kind: "thinking";
      key: string;
      text: string;
      running?: boolean;
      postedAt?: string;
    }
  | {
      kind: "tool";
      key: string;
      name: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      structuredPatch?: unknown;
      running?: boolean;
      postedAt?: string;
    };

export interface SubagentSummary {
  /** The spawning Task tool_use id (== the `subagent:` node suffix). */
  parentId: string;
  /** The `subagent_type` (e.g. `explore`). */
  type: string;
  background: boolean;
  running: boolean;
  toolCount: number;
  /** A one-line gist (the Task `description`, else the first line of its prompt). */
  summary: string;
  /**
   * The subagent's OWN live context occupancy + model, from a `parentToolUseId`-tagged `usage` frame (see
   * `LiveTurn.subUsage`). Optional: absent until the subagent's first round-trip reports usage, and absent
   * entirely for durable/reloaded cards until Part 2d persists it. `contextModel` is the raw model id (fed
   * to `formatModelLabel`); the card falls back to the static type→model map when it's missing.
   */
  contextTokens?: number;
  contextLimit?: number;
  contextModel?: string;
}

const firstLine = (v: unknown): string =>
  typeof v === "string" ? v.split("\n")[0]!.trim() : "";
export const subagentLabel = (type: string): string =>
  `${type.charAt(0).toUpperCase()}${type.slice(1)} agent`;

// ── Durable side (JobMessage[]) ────────────────────────────────────────────────────────────────

export interface DurableSubagentIndex {
  /** `message.ts` of every block that belongs to a subagent (skip these in the main log). */
  childKeys: Set<string>;
  /** `message.ts` of every Task anchor (render these as a card, not in a tool group). */
  anchorKeys: Set<string>;
  /** parentId → the anchor's summary. */
  summaryById: Map<string, SubagentSummary>;
  /** parentId → its child messages, in order. */
  childrenById: Map<string, JobMessage[]>;
}

export function indexDurableSubagents(
  messages: JobMessage[],
): DurableSubagentIndex {
  const childrenById = new Map<string, JobMessage[]>();
  const childKeys = new Set<string>();
  for (const m of messages) {
    const p =
      typeof m.meta?.parentToolUseId === "string"
        ? m.meta.parentToolUseId
        : null;
    if (!p) continue;
    childKeys.add(m.ts);
    const arr = childrenById.get(p);
    if (arr) arr.push(m);
    else childrenById.set(p, [m]);
  }

  const summaryById = new Map<string, SubagentSummary>();
  const anchorKeys = new Set<string>();
  for (const m of messages) {
    const id = typeof m.meta?.id === "string" ? m.meta.id : null;
    if (m.kind !== "tool" || !id || !childrenById.has(id)) continue;
    anchorKeys.add(m.ts);
    const input = (m.meta?.input ?? {}) as Record<string, unknown>;
    const kids = childrenById.get(id) ?? [];
    // The subagent's last durable occupancy, stamped onto its anchor Task block by the turn harness
    // (`subContext*`). Absent for pre-2d turns / a subagent that never reported usage → no ring.
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    summaryById.set(id, {
      parentId: id,
      type: String(input.subagent_type ?? "agent"),
      background: Boolean(input.run_in_background),
      running: m.meta?.result == null,
      toolCount: kids.filter((k) => k.kind === "tool").length,
      summary: String(input.description || firstLine(input.prompt)),
      ...(typeof meta.subContextTokens === "number"
        ? { contextTokens: meta.subContextTokens }
        : {}),
      ...(typeof meta.subContextLimit === "number"
        ? { contextLimit: meta.subContextLimit }
        : {}),
      ...(typeof meta.subContextModel === "string"
        ? { contextModel: meta.subContextModel }
        : {}),
    });
  }
  return { childKeys, anchorKeys, summaryById, childrenById };
}

/** The Task anchor's prompt (full) — for the detail pane's collapsible "Task prompt". */
export function durableSubagentPrompt(
  messages: JobMessage[],
  parentId: string,
): string {
  for (const m of messages) {
    if (m.kind === "tool" && m.meta?.id === parentId) {
      const input = (m.meta?.input ?? {}) as Record<string, unknown>;
      return typeof input.prompt === "string" ? input.prompt : "";
    }
  }
  return "";
}

export function durableSubBlocks(children: JobMessage[]): SubBlock[] {
  return children.map((m): SubBlock => {
    if (m.kind === "thinking")
      return {
        kind: "thinking",
        key: m.ts,
        text: m.text,
        postedAt: m.postedAt,
      };
    if (m.kind === "tool") {
      const mm = m.meta ?? {};
      return {
        kind: "tool",
        key: m.ts,
        name: String(mm.name ?? "tool"),
        input: mm.input,
        result: mm.result,
        isError: Boolean(mm.isError),
        structuredPatch: mm.structuredPatch,
        postedAt: m.postedAt,
      };
    }
    return { kind: "text", key: m.ts, text: m.text, postedAt: m.postedAt };
  });
}

// ── Live side (LiveBlock[]) ───────────────────────────────────────────────────────────────────────

export interface LiveSubagentIndex {
  childKeys: Set<string>;
  anchorKeys: Set<string>;
  summaryById: Map<string, SubagentSummary>;
}

export function indexLiveSubagents(blocks: LiveBlock[]): LiveSubagentIndex {
  const childParentIds = new Set<string>();
  const childCountById = new Map<string, number>();
  for (const b of blocks) {
    const p = b.parentToolUseId;
    if (!p) continue;
    childParentIds.add(p);
    if (b.kind === "tool")
      childCountById.set(p, (childCountById.get(p) ?? 0) + 1);
  }

  const childKeys = new Set<string>();
  const anchorKeys = new Set<string>();
  const summaryById = new Map<string, SubagentSummary>();
  for (const b of blocks) {
    if (b.parentToolUseId) childKeys.add(b.key);
    if (b.kind === "tool" && b.toolId && childParentIds.has(b.toolId)) {
      anchorKeys.add(b.key);
      const input = (b.input ?? {}) as Record<string, unknown>;
      summaryById.set(b.toolId, {
        parentId: b.toolId,
        type: String(input.subagent_type ?? "agent"),
        background: Boolean(input.run_in_background),
        running: !b.done,
        toolCount: childCountById.get(b.toolId) ?? 0,
        summary: String(input.description || firstLine(input.prompt)),
      });
    }
  }
  return { childKeys, anchorKeys, summaryById };
}

/** The spawning Task block's full prompt from the LIVE turn — the durable anchor isn't persisted until the
 *  turn ends, so during streaming the prompt has to come off the live blocks (else the run's "first
 *  message" is blank until it finishes). */
export function liveSubagentPrompt(
  blocks: LiveBlock[],
  parentId: string,
): string {
  for (const b of blocks) {
    if (b.kind === "tool" && b.toolId === parentId) {
      const input = (b.input ?? {}) as Record<string, unknown>;
      return typeof input.prompt === "string" ? input.prompt : "";
    }
  }
  return "";
}

export function liveSubBlocksForParent(
  blocks: LiveBlock[],
  parentId: string,
): SubBlock[] {
  const out: SubBlock[] = [];
  for (const b of blocks) {
    if (b.parentToolUseId !== parentId) continue;
    if (b.kind === "tool")
      out.push({
        kind: "tool",
        key: b.key,
        name: b.name,
        input: b.input,
        result: b.result,
        isError: b.isError,
        structuredPatch: b.structuredPatch,
        running: !b.done,
      });
    else out.push({ kind: b.kind, key: b.key, text: b.text, running: !b.done });
  }
  return out;
}

// ── The conversation card ─────────────────────────────────────────────────────────────────────────

/**
 * The compact card that stands in for a subagent run in the MAIN conversation. The run's tool calls and
 * narration are NOT inlined here — they live in the detail pane, opened via "Viewing run →".
 */
export function SubagentCard({
  summary,
  onOpen,
}: {
  summary: SubagentSummary;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Prefer the subagent's REAL model (from its own `usage` frame) over the static type→model guess.
  const model = formatModelLabel(summary.contextModel) ?? subagentModel(summary.type);
  const hasRing =
    typeof summary.contextTokens === "number" &&
    typeof summary.contextLimit === "number" &&
    summary.contextLimit > 0;
  return (
    <div
      className="anim-fadeUp my-px rounded-[10px] border"
      style={{
        borderColor: summary.running ? "var(--accent-line)" : "var(--border)",
        background: summary.running
          ? "var(--accent-soft)"
          : "color-mix(in srgb, var(--surface-2) 55%, transparent)",
      }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{
            background:
              "linear-gradient(145deg, var(--accent), var(--accent-2))",
          }}
          aria-hidden
        >
          <Sparkles size={13} color="#fff" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-text">
              {subagentLabel(summary.type)}
            </span>
            {summary.background ? (
              <span className="rounded-sm bg-surface-3 px-1.5 py-px font-mono text-[8.5px] uppercase tracking-[0.1em] text-faint">
                background
              </span>
            ) : null}
            <span className="flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-faint">
              {summary.running ? (
                <span
                  className="pulse-dot h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--accent)" }}
                />
              ) : null}
              {summary.running ? "running" : "done"}
            </span>
          </div>
          {summary.summary ? (
            <span className="mt-0.5 truncate text-[11.5px] text-dim">
              {summary.summary}
            </span>
          ) : null}
          <span className="mt-0.5 font-mono text-[10px] text-faint">
            {summary.toolCount} tool{summary.toolCount === 1 ? "" : "s"}
            {model ? ` · ${model}` : ""}
          </span>
        </div>
        {hasRing ? (
          <ContextMeter
            tokens={summary.contextTokens!}
            limit={summary.contextLimit!}
            model={summary.contextModel}
            size={15}
          />
        ) : null}
        <button
          type="button"
          onClick={onOpen}
          className="flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium text-accent transition hover:bg-surface-3"
          style={{
            background: "var(--accent-soft)",
            border: "1px solid var(--accent-line)",
          }}
        >
          Viewing run →
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left font-mono text-[10px] text-faint transition hover:text-dim"
        style={{ borderColor: "var(--hair)" }}
      >
        <ChevronRight
          size={10}
          strokeWidth={2.6}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        raw tool payload
      </button>
      {open ? (
        <p className="px-3 pb-2.5 font-mono text-[10.5px] leading-relaxed text-dim">
          subagent_type: <span className="text-text">{summary.type}</span>
          {model ? (
            <>
              {" · "}model: <span className="text-text">{model}</span>
            </>
          ) : null}
          {" · "}id:{" "}
          <span className="text-text">{summary.parentId.slice(0, 12)}…</span>
        </p>
      ) : null}
    </div>
  );
}
