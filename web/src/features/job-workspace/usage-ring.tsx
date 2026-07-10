"use client";

import { useEffect, useRef, useState } from "react";
import { useOrgUsage } from "@/lib/api/orgs";
import { formatClockTime } from "@/lib/org-display";
import type { WireOrgUsage } from "@/lib/api/types";

type UsageWindow = WireOrgUsage["fiveHour"];

const RING_R = 7;
const RING_CIRC = 2 * Math.PI * RING_R;
const RING_STROKE = 2.2;

function ringColor(pct: number): string {
  if (pct >= 0.9) return "var(--red)";
  if (pct >= 0.7) return "var(--accent-2)";
  return "var(--accent)";
}

function Ring({
  pct,
  size,
  dimmed,
}: {
  pct: number;
  size: number;
  dimmed: boolean;
}) {
  const stroke = dimmed ? "var(--border)" : ringColor(pct);
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" className="-rotate-90">
      <circle
        cx="9"
        cy="9"
        r={RING_R}
        fill="none"
        stroke="var(--border)"
        strokeWidth={RING_STROKE}
      />
      {dimmed ? null : (
        <circle
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          stroke={stroke}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${RING_CIRC * pct} ${RING_CIRC}`}
        />
      )}
    </svg>
  );
}

/**
 * One window's row in the usage panel — a thin bar + reset time. Always rendered (session/weekly/…): when
 * the window is unknown it shows a muted "unknown" placeholder rather than disappearing, so the panel always
 * lists every window the operator expects.
 */
function WindowRow({ label, window }: { label: string; window: UsageWindow }) {
  const pct = window ? Math.min(1, Math.max(0, window.utilization / 100)) : 0;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-dim">{label}</span>
        {window ? (
          <span className="font-mono text-[10px] tabular-nums text-faint">
            {Math.round(window.utilization)}% · resets{" "}
            {formatClockTime(window.resetsAt)}
          </span>
        ) : (
          <span className="font-mono text-[10px] tabular-nums text-faint">
            unknown
          </span>
        )}
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-border">
        {window ? (
          <div
            className="h-full rounded-full"
            style={{ width: `${pct * 100}%`, background: ringColor(pct) }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A subscription-usage ring (Claude Code `/usage` style) for the composer footer — the SESSION (5-hour)
 * window as a small SVG arc + %. CLICK it to open a panel breaking out every window
 * (session/weekly/Opus/Sonnet); each unknown window shows "unknown" so the panel always lists all four.
 * DEGRADED (loading, `ok:false`, or no 5-hour window): the ring renders dimmed with no number — the usage
 * endpoint is best-effort and must never block or error the composer — but the panel still opens on click.
 */
export function UsageRing({ orgId, size = 17 }: { orgId: string; size?: number }) {
  const { data, isLoading } = useOrgUsage(orgId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const degraded = isLoading || data?.ok === false || !data?.fiveHour;
  const fiveHour = data?.fiveHour ?? null;
  const pct = fiveHour ? Math.min(1, Math.max(0, fiveHour.utilization / 100)) : 0;

  const title = degraded
    ? "Claude usage · unknown right now — click for details"
    : `Session usage · ${Math.round(fiveHour!.utilization)}% (resets ${formatClockTime(fiveHour!.resetsAt)}) — click for details`;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 transition hover:bg-surface-2"
        title={title}
        aria-label="Claude subscription usage"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ring pct={pct} size={size} dimmed={degraded} />
        <span
          className={`font-mono text-[10px] tabular-nums ${degraded ? "text-faint" : "text-dim"}`}
        >
          {degraded ? "—" : `${Math.round(pct * 100)}%`}
        </span>
      </button>
      {open ? (
        <div
          className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-[9px] border p-2.5 shadow-lg"
          style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        >
          <div className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-faint">
            Claude usage
          </div>
          <div className="flex flex-col gap-2">
            <WindowRow label="Session (5h)" window={data?.fiveHour ?? null} />
            <WindowRow label="Weekly (7d)" window={data?.sevenDay ?? null} />
            <WindowRow label="Opus (7d)" window={data?.sevenDayOpus ?? null} />
            <WindowRow label="Sonnet (7d)" window={data?.sevenDaySonnet ?? null} />
          </div>
          {data && data.ok === false ? (
            <div className="mt-2 text-[10px] text-faint">
              Usage is unavailable right now.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
