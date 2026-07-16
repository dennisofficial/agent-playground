"use client";

import { useState } from "react";
import { formatTokens } from "@/lib/org-display";
import type { ContextBreakdown, ContextBreakdownCategory } from "@/lib/api/job-stream";

/** Name literally reported by the SDK for the synthetic free-space category — pinned last, per the mockup. */
const FREE_SPACE_NAME = "Free space";

/** Fixed name→theme-token swatch colors (case-sensitive, matches the SDK's exact category names). */
const SWATCH_COLOR: Record<string, string> = {
  Messages: "var(--accent)",
  "Memory files": "var(--blue)",
  "System tools": "var(--purple)",
  Skills: "var(--green)",
  "System prompt": "var(--red)",
  "MCP tools": "var(--accent-2)",
  "Custom agents": "var(--blue)",
};

/** A CSS color the SDK's own `category.color` field can plausibly be used as (hex, rgb()/hsl(), or a `var(--…)`). */
function looksLikeCssColor(color: string | undefined): color is string {
  if (!color) return false;
  return /^#|^rgb|^hsl|^var\(/.test(color.trim());
}

function swatchColor(cat: ContextBreakdownCategory): string {
  if (cat.name === FREE_SPACE_NAME) return "transparent";
  return SWATCH_COLOR[cat.name] ?? (looksLikeCssColor(cat.color) ? cat.color : "var(--faint)");
}

/** One category row, sorted-and-placed by the caller; free space is a synthetic row with no detail data. */
type Row = { name: string; tokens: number; color: string; isFreeSpace: boolean };

/** Partition + sort the SDK categories into display rows, always ending on exactly one Free-space row. */
function buildRows(breakdown: ContextBreakdown): Row[] {
  const sdkFreeSpace = breakdown.categories.find((c) => c.name === FREE_SPACE_NAME);
  const rest = breakdown.categories
    .filter((c) => c.name !== FREE_SPACE_NAME)
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .map((c) => ({ name: c.name, tokens: c.tokens, color: swatchColor(c), isFreeSpace: false }));
  const freeSpaceTokens = sdkFreeSpace
    ? sdkFreeSpace.tokens
    : Math.max(0, breakdown.maxTokens - breakdown.totalTokens);
  return [
    ...rest,
    { name: FREE_SPACE_NAME, tokens: freeSpaceTokens, color: "transparent", isFreeSpace: true },
  ];
}

function pctOf(tokens: number, maxTokens: number): string {
  return maxTokens > 0 ? ((tokens / maxTokens) * 100).toFixed(1) : "0.0";
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function Chevron({ open, hasDetail }: { open: boolean; hasDetail: boolean }) {
  if (!hasDetail) return <span className="w-2 shrink-0 text-[8px] invisible">▸</span>;
  return (
    <span
      className="w-2 shrink-0 text-[8px] text-faint transition-transform"
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      ▸
    </span>
  );
}

function SubRow({ name, tokens }: { name: string; tokens: number }) {
  return (
    <div className="flex items-center gap-1.5 px-0.5 py-0.5">
      <span className="h-[3px] w-[3px] shrink-0 rounded-full" style={{ background: "var(--border-2)" }} />
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">{name}</span>
      <span className="whitespace-nowrap font-mono text-[9.5px] tabular-nums text-faint opacity-85">
        {formatTokens(tokens)}
      </span>
    </div>
  );
}

/** A category row's expandable detail — undefined/empty means the row isn't clickable at all. */
function detailFor(
  row: Row,
  breakdown: ContextBreakdown,
): { key: string; subRows: { name: string; tokens: number }[] } | null {
  if (row.name === "Memory files" && breakdown.memoryFiles?.length) {
    return {
      key: "memoryFiles",
      subRows: breakdown.memoryFiles.map((f) => ({ name: basename(f.path), tokens: f.tokens })),
    };
  }
  if (row.name === "MCP tools" && breakdown.mcpTools?.length) {
    return {
      key: "mcpTools",
      subRows: breakdown.mcpTools.map((t) => ({ name: t.name, tokens: t.tokens })),
    };
  }
  if (row.name === "Custom agents" && breakdown.agents?.length) {
    return {
      key: "agents",
      subRows: breakdown.agents.map((a) => ({ name: a.agentType, tokens: a.tokens })),
    };
  }
  return null;
}

function CategoryRow({
  row,
  breakdown,
  expanded,
  onToggle,
}: {
  row: Row;
  breakdown: ContextBreakdown;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detail = detailFor(row, breakdown);
  const clickable = detail != null;
  const pct = pctOf(row.tokens, breakdown.maxTokens);

  const rowContent = (
    <>
      <Chevron open={expanded} hasDetail={clickable} />
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
        style={
          row.isFreeSpace
            ? { background: "transparent", border: "1.3px solid var(--border-2)" }
            : { background: row.color }
        }
      />
      <span className={`min-w-0 flex-1 truncate text-[11px] ${row.isFreeSpace ? "text-faint" : "text-dim"}`}>
        {row.name}
      </span>
      <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-faint">
        {formatTokens(row.tokens)}
      </span>
      <span className="w-[34px] shrink-0 whitespace-nowrap text-right font-mono text-[10px] tabular-nums text-faint">
        {pct}%
      </span>
    </>
  );

  return (
    <div className="flex flex-col">
      {clickable ? (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-1 transition hover:bg-surface-3"
        >
          {rowContent}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 px-0.5 py-1">{rowContent}</div>
      )}
      {clickable && expanded ? (
        <div className="flex flex-col gap-px py-0.5 pl-[22px]">
          {detail.subRows.map((s) => (
            <SubRow key={s.name} name={s.name} tokens={s.tokens} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Claude-Desktop-style context-window breakdown popover — a segmented usage bar + per-category rows
 * (Messages, Memory files, System tools, Skills, System prompt, MCP tools, Custom agents, Free space),
 * with Memory files / MCP tools / Custom agents expandable to their per-item detail. Rendered by
 * {@link ContextMeter} when its `breakdown` prop is present. Matches `/context/artifacts/context-breakdown-popover.html`.
 */
export function ContextBreakdownPanel({
  breakdown,
  tokens,
  limit,
  model,
  onClose,
}: {
  breakdown: ContextBreakdown;
  tokens: number;
  limit: number;
  model?: string;
  onClose?: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = buildRows(breakdown);
  const pct = Math.round(breakdown.percentage);
  const headerModel = model ?? breakdown.model;

  return (
    <div role="dialog" aria-label="Context window usage">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-dim">{headerModel}</span>
        <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-faint">
          <b className="font-semibold text-dim">{formatTokens(tokens)}</b> / {formatTokens(limit)} ({pct}%)
        </span>
      </div>

      <div
        className="mb-2.5 flex h-[5px] w-full overflow-hidden rounded-full"
        style={{ background: "var(--border)" }}
        aria-hidden
      >
        {rows
          .filter((r) => !r.isFreeSpace)
          .map((r) => (
            <span
              key={r.name}
              style={{ width: `${(r.tokens / breakdown.maxTokens) * 100}%`, background: r.color }}
            />
          ))}
      </div>

      <div className="flex flex-col gap-px">
        {rows.map((row) => {
          const detail = detailFor(row, breakdown);
          const key = detail?.key ?? row.name;
          return (
            <CategoryRow
              key={row.name}
              row={row}
              breakdown={breakdown}
              expanded={!!expanded[key]}
              onToggle={() => setExpanded((cur) => ({ ...cur, [key]: !cur[key] }))}
            />
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-1.5 border-t pt-2" style={{ borderColor: "var(--border)" }}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--green)" }} />
        <span className="font-mono text-[10px] text-faint">Updated just now</span>
      </div>
    </div>
  );
}
