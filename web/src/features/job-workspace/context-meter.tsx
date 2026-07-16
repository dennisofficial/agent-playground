"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTokens } from "@/lib/org-display";
import type { ContextBreakdown } from "@/lib/api/job-stream";
import { ContextBreakdownPanel } from "./context-breakdown-panel";

/**
 * A context-window occupancy ring (Claude-Code style) — a small SVG arc + center %. `tokens` is the last
 * turn's input-token count (≈ what's resident in context); `limit` is the model's window. Turns amber/red
 * as it fills. The model/limit come from the latest `turn_meta` block, so it threads whatever model ran.
 * `size` scales the ring for tighter surfaces (e.g. a subagent card) while keeping the same arc geometry.
 *
 * When `breakdown` is present (the composer's main-agent ring, once the engine has reported one), the ring
 * becomes a click target opening a Claude-Desktop-style popover ({@link ContextBreakdownPanel}) with the
 * per-category usage. Without it (Codex threads, a subagent's ring, or before the first turn's breakdown
 * lands) the ring renders exactly as before — a plain non-interactive tooltip'd `<div>`.
 */
export function ContextMeter({
  tokens,
  limit,
  model,
  size = 17,
  breakdown,
}: {
  tokens: number;
  limit: number;
  model?: string;
  size?: number;
  breakdown?: ContextBreakdown | null;
}) {
  const pct = limit > 0 ? Math.min(1, Math.max(0, tokens / limit)) : 0;
  const r = 7;
  const circ = 2 * Math.PI * r;
  const stroke =
    pct >= 0.9
      ? "var(--red)"
      : pct >= 0.7
        ? "var(--accent-2)"
        : "var(--accent)";
  const title = `Context · ${formatTokens(tokens)} / ${formatTokens(limit)} (${Math.round(pct * 100)}%)${model ? ` · ${model}` : ""}`;

  const ring = (
    <svg width={size} height={size} viewBox="0 0 18 18" className="-rotate-90">
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth="2.2"
      />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray={`${circ * pct} ${circ}`}
      />
    </svg>
  );
  const label = (
    <span className="font-mono text-[10px] tabular-nums text-dim">
      {Math.round(pct * 100)}%
    </span>
  );

  if (!breakdown) {
    return (
      <div className="flex items-center gap-1.5 px-1" title={title}>
        {ring}
        {label}
      </div>
    );
  }

  return (
    <ClickableContextMeter
      tokens={tokens}
      limit={limit}
      model={model}
      title={title}
      breakdown={breakdown}
      ring={ring}
      label={label}
    />
  );
}

/** The clickable variant, split out so the plain (non-breakdown) path above never pays for the extra hooks. */
function ClickableContextMeter({
  tokens,
  limit,
  model,
  title,
  breakdown,
  ring,
  label,
}: {
  tokens: number;
  limit: number;
  model?: string;
  title: string;
  breakdown: ContextBreakdown;
  ring: React.ReactNode;
  label: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Keep the panel within the viewport, same clamp as `usage-ring.tsx`'s `UsageRingView`.
  useLayoutEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const measure = () => {
      const el = panelRef.current;
      if (!el) return;
      const margin = 8;
      const rect = el.getBoundingClientRect();
      const naturalLeft = rect.left - shiftX;
      const naturalRight = rect.right - shiftX;
      let next = 0;
      if (naturalLeft < margin) next = margin - naturalLeft;
      else if (naturalRight > window.innerWidth - margin)
        next = window.innerWidth - margin - naturalRight;
      setShiftX(next);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // `shiftX` is intentionally omitted: it's derived here, and re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition hover:bg-surface-2"
        title={title}
        aria-label="Context window usage"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {ring}
        {label}
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-1rem)] rounded-[9px] border p-2.5 shadow-lg"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-2)",
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
          }}
        >
          <ContextBreakdownPanel
            breakdown={breakdown}
            tokens={tokens}
            limit={limit}
            model={model}
          />
        </div>
      ) : null}
    </div>
  );
}
