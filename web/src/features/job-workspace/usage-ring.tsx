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

/** Compact "time since" for the panel's last-updated stamp. Returns null for missing/unparseable input. */
function timeAgo(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

/** One window's row in the usage panel — a thin bar + reset time. Only rendered for windows we have data for. */
function WindowRow({
  label,
  window,
}: {
  label: string;
  window: NonNullable<UsageWindow>;
}) {
  const pct = Math.min(1, Math.max(0, window.utilization / 100));
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-dim">{label}</span>
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {Math.round(window.utilization)}% · resets {formatClockTime(window.resetsAt)}
        </span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct * 100}%`, background: ringColor(pct) }}
        />
      </div>
    </div>
  );
}

/**
 * A subscription-usage ring (Claude Code `/usage` style) for the composer footer — the SESSION (5-hour)
 * window as a small SVG arc + %. CLICK it to open a panel that lists ONLY the windows we have data for
 * (session/weekly/Opus/Sonnet — rendered dynamically, absent windows are omitted). The ring stays visible
 * with a "none" state (dimmed, no number) when we have nothing yet — the usage endpoint is best-effort and
 * must never block or error the composer.
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
          {(() => {
            const entries: [string, UsageWindow][] = [
              ["Session (5h)", data?.fiveHour ?? null],
              ["Weekly (7d)", data?.sevenDay ?? null],
              ["Opus (7d)", data?.sevenDayOpus ?? null],
              ["Sonnet (7d)", data?.sevenDaySonnet ?? null],
            ];
            const rows = entries.filter(
              (r): r is [string, NonNullable<UsageWindow>] => r[1] !== null,
            );
            if (rows.length === 0) {
              return <div className="text-[11px] text-faint">No usage data yet.</div>;
            }
            return (
              <>
                <div className="flex flex-col gap-2">
                  {rows.map(([label, window]) => (
                    <WindowRow key={label} label={label} window={window} />
                  ))}
                </div>
                <div
                  className="mt-2 border-t pt-1.5 text-[10px] text-faint"
                  style={{ borderColor: "var(--border)" }}
                >
                  Updated {timeAgo(data?.fetchedAt) ?? "recently"}
                </div>
              </>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}
