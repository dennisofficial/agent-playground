"use client";

import { useEffect, useRef, useState } from "react";
import { useOrgUsage } from "@/lib/api/orgs";
import { formatClockTime } from "@/lib/org-display";
import type { WireOrgUsage } from "@/lib/api/types";

type UsageWindow = WireOrgUsage["fiveHour"];
type RingVisualState = "active" | "pending" | "degraded";

const RING_R = 7;
const RING_CIRC = 2 * Math.PI * RING_R;
const RING_STROKE = 2.2;

const SESSION_WARNING_THRESHOLD = 0.7;
const SESSION_LIMIT_THRESHOLD = 0.9;
const WEEKLY_CAPPED_THRESHOLD = 0.95;
/** Weekly grey peaks (darkest in light theme, brightest in dark) at the half-week mark, then holds. */
const WEEKLY_GREY_PEAK_PCT = 0.5;
const WEEKLY_GREY_MIN_MIX = 15;
const WEEKLY_GREY_MAX_MIX = 68;

const FRESHNESS_STALE_MS = 10 * 60_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function clampPct(fraction: number): number {
  return Math.min(1, Math.max(0, fraction));
}

/** Accent → accent-2 → red by the shared usage thresholds. Drives BOTH the session arc and every panel row. */
function thresholdColor(pct: number): string {
  if (pct >= SESSION_LIMIT_THRESHOLD) return "var(--red)";
  if (pct >= SESSION_WARNING_THRESHOLD) return "var(--accent-2)";
  return "var(--accent)";
}

/**
 * Grey mix % for the weekly arc, ramping from faint to darkest across 0–50% weekly then holding. Uses
 * `color-mix` against `var(--dim)` (not a hardcoded hex) so the SAME curve reads as "darkens" on a light
 * surface and "brightens" on a dark one — `--dim` itself is the theme-appropriate mid tone in each theme.
 */
function weeklyGreyMix(pct: number): number {
  const ramp = Math.min(pct, WEEKLY_GREY_PEAK_PCT) / WEEKLY_GREY_PEAK_PCT;
  return Math.round(WEEKLY_GREY_MIN_MIX + ramp * (WEEKLY_GREY_MAX_MIX - WEEKLY_GREY_MIN_MIX));
}

function weeklyArcColor(pct: number): string {
  if (pct >= WEEKLY_CAPPED_THRESHOLD) return "var(--red)";
  return `color-mix(in srgb, var(--dim) ${weeklyGreyMix(pct)}%, transparent)`;
}

function isFresh(fetchedAt: string | undefined, now: number = Date.now()): boolean {
  if (!fetchedAt) return false;
  const then = new Date(fetchedAt).getTime();
  if (Number.isNaN(then)) return false;
  return now - then <= FRESHNESS_STALE_MS;
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

/** Countdown to a reset ("4d 6h" / "4h 05m" / "13m"), clamped at 0. Null for missing/unparseable input. */
function formatCountdown(resetsAt: string | undefined, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const remainingMs = Math.max(0, target - now);

  const days = Math.floor(remainingMs / MS_PER_DAY);
  if (days >= 1) {
    const hours = Math.floor((remainingMs % MS_PER_DAY) / MS_PER_HOUR);
    return `${days}d ${hours}h`;
  }
  const hours = Math.floor(remainingMs / MS_PER_HOUR);
  if (hours >= 1) {
    const minutes = Math.floor((remainingMs % MS_PER_HOUR) / MS_PER_MINUTE);
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  const minutes = Math.floor(remainingMs / MS_PER_MINUTE);
  return `${minutes}m`;
}

/**
 * Human reset time — same-day reuses {@link formatClockTime} ("6:40 PM today"); ≥1 day out adds the
 * weekday + date ("Sun, Jul 13 · 5:00 AM"). Null for missing/unparseable input.
 */
function formatResetHuman(resetsAt: string | undefined, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const t = new Date(resetsAt).getTime();
  if (Number.isNaN(t)) return null;
  const target = new Date(t);
  const today = new Date(now);
  const sameDay =
    target.getFullYear() === today.getFullYear() &&
    target.getMonth() === today.getMonth() &&
    target.getDate() === today.getDate();
  if (sameDay) return `${formatClockTime(resetsAt)} today`;
  const weekday = target.toLocaleDateString(undefined, { weekday: "short" });
  const monthDay = target.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = target.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${weekday}, ${monthDay} · ${time}`;
}

function firstLetter(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}

/**
 * The inline ring glyph — a single groove with NO background track. `active` overlays two arcs, both
 * starting at 12 o'clock and growing clockwise: the grey/red WEEKLY arc behind, the accent/red SESSION
 * arc on top (the headline). `pending` (no data harvested yet) draws a clean thin empty outline; `degraded`
 * (unknown/stale) draws a faint dashed outline. Neither of those draws a fill — there's nothing to show yet.
 */
function Ring({
  state,
  sessionPct,
  weeklyPct,
  atLimit,
  size,
}: {
  state: RingVisualState;
  sessionPct: number;
  weeklyPct: number;
  atLimit: boolean;
  size: number;
}) {
  if (state === "degraded") {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
        <circle
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          stroke="var(--border)"
          strokeWidth={RING_STROKE}
          strokeDasharray="1.8 2"
          opacity={0.7}
        />
      </svg>
    );
  }

  if (state === "pending") {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={RING_R} fill="none" stroke="var(--border)" strokeWidth={RING_STROKE} />
        <circle cx="9" cy="9" r={1.4} fill="var(--faint)" opacity={0.45} />
      </svg>
    );
  }

  const sessionColor = atLimit ? "var(--red)" : thresholdColor(sessionPct);
  const sessionDasharray = atLimit
    ? `${RING_CIRC} ${RING_CIRC}`
    : `${RING_CIRC * sessionPct} ${RING_CIRC}`;

  return (
    <svg width={size} height={size} viewBox="0 0 18 18" className="-rotate-90" aria-hidden>
      <circle
        cx="9"
        cy="9"
        r={RING_R}
        fill="none"
        stroke={weeklyArcColor(weeklyPct)}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRC * weeklyPct} ${RING_CIRC}`}
      />
      <circle
        cx="9"
        cy="9"
        r={RING_R}
        fill="none"
        stroke={sessionColor}
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={sessionDasharray}
      />
      {atLimit ? <circle cx="9" cy="9" r={1.5} fill="var(--red)" /> : null}
    </svg>
  );
}

/** The panel header — active account (avatar + label + display-only chevron) and plan badge. Falls back
 *  to a neutral title when the backend hasn't populated multi-account fields yet. */
function PanelHeader({ accountLabel, plan }: { accountLabel?: string; plan?: string }) {
  if (!accountLabel) {
    return (
      <div className="mb-2 flex items-center">
        <span className="text-[11px] font-medium text-dim">Claude subscription</span>
      </div>
    );
  }
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold"
          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
        >
          {firstLetter(accountLabel)}
        </span>
        <span className="truncate text-[11px] font-medium text-dim">{accountLabel}</span>
        <span className="text-[9px] text-faint" aria-hidden>
          ▾
        </span>
      </div>
      {plan ? (
        <span
          className="shrink-0 rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] text-faint"
          style={{ borderColor: "var(--border)" }}
        >
          {plan}
        </span>
      ) : null}
    </div>
  );
}

/** One window's row in the usage panel — a colored dot + label, a thin progress bar, and a reset line.
 *  Only rendered for windows we have data for; `dimmed` mutes a stale (not-fresh) snapshot's rows. */
function WindowRow({
  label,
  window,
  dimmed,
}: {
  label: string;
  window: NonNullable<UsageWindow>;
  dimmed: boolean;
}) {
  const pct = clampPct(window.utilization / 100);
  const color = thresholdColor(pct);
  const countdown = formatCountdown(window.resetsAt);
  const resetHuman = formatResetHuman(window.resetsAt);
  return (
    <div className={`flex flex-col gap-1 ${dimmed ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: color }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {Math.round(window.utilization)}%{countdown ? ` · ${countdown}` : ""}
        </span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
      {resetHuman ? <div className="text-[10px] text-faint">resets {resetHuman}</div> : null}
    </div>
  );
}

/** Pending/empty panel body — no window has any data yet (a fresh token, nothing harvested). */
function EmptyUsagePanel() {
  return (
    <>
      <div className="flex flex-col items-center gap-1.5 px-1 py-4 text-center">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full border"
          style={{ borderColor: "var(--border)" }}
        >
          <Ring state="pending" sessionPct={0} weeklyPct={0} atLimit={false} size={16} />
        </span>
        <div className="text-[11px] font-semibold text-dim">No usage yet</div>
        <div className="max-w-[190px] text-[10px] text-faint">
          Usage appears after your first agent turn.
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 border-t pt-1.5" style={{ borderColor: "var(--border)" }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--faint)" }} />
        <span className="font-mono text-[10px] text-faint">Waiting for first turn</span>
      </div>
    </>
  );
}

/** Panel footer — a freshness dot (green when fresh, amber when stale) + the last-fetched relative time. */
function PanelFooter({ fetchedAt }: { fetchedAt: string | undefined }) {
  const fresh = isFresh(fetchedAt);
  return (
    <div className="mt-2.5 flex items-center gap-1.5 border-t pt-1.5" style={{ borderColor: "var(--border)" }}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: fresh ? "var(--green)" : "var(--accent-2)" }}
      />
      <span
        className="font-mono text-[10px]"
        style={{ color: fresh ? "var(--faint)" : "var(--accent-2)" }}
      >
        Updated {timeAgo(fetchedAt) ?? "recently"}
      </span>
    </div>
  );
}

/**
 * A subscription-usage ring (Claude Code `/usage` style) for the composer footer — the SESSION (5-hour)
 * window as a small SVG arc + %, with the WEEKLY (7-day) window as a second arc sharing the same groove
 * behind it. CLICK it to open a panel listing every window we have data for (session/weekly/Opus/Sonnet,
 * rendered dynamically — absent windows are omitted). The ring always stays visible, with dedicated
 * "pending" (no data yet) and "degraded" (unknown/stale) states — the usage endpoint is best-effort and
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

  const rows: [string, NonNullable<UsageWindow>][] = (
    [
      ["Session · 5h", data?.fiveHour ?? null],
      ["Weekly · all models · 7d", data?.sevenDay ?? null],
      ["Opus · 7d", data?.sevenDayOpus ?? null],
      ["Sonnet · 7d", data?.sevenDaySonnet ?? null],
    ] as [string, UsageWindow][]
  ).filter((row): row is [string, NonNullable<UsageWindow>] => row[1] !== null);

  const visualState: RingVisualState =
    (isLoading && !data) || data?.ok === false
      ? "degraded"
      : rows.length === 0
        ? "pending"
        : "active";

  const sessionPct = data?.fiveHour ? clampPct(data.fiveHour.utilization / 100) : 0;
  const weeklyPct = data?.sevenDay ? clampPct(data.sevenDay.utilization / 100) : 0;
  const atLimit = visualState === "active" && sessionPct >= SESSION_LIMIT_THRESHOLD;

  const labelText =
    visualState === "degraded" ? "–" : visualState === "pending" ? "·" : `${Math.round(sessionPct * 100)}%`;
  const labelClassName = visualState === "active" && !atLimit ? "text-dim" : atLimit ? "" : "text-faint";
  const labelStyle = atLimit ? { color: "var(--red)" } : undefined;

  const title =
    visualState === "degraded"
      ? "Claude usage · unknown right now — click for details"
      : visualState === "pending"
        ? "Claude usage · no data yet — click for details"
        : `Session usage · ${Math.round(sessionPct * 100)}%${
            data?.fiveHour ? ` (resets ${formatClockTime(data.fiveHour.resetsAt)})` : ""
          } — click for details`;

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
        <Ring state={visualState} sessionPct={sessionPct} weeklyPct={weeklyPct} atLimit={atLimit} size={size} />
        <span className={`font-mono text-[10px] tabular-nums ${labelClassName}`} style={labelStyle}>
          {labelText}
        </span>
      </button>
      {open ? (
        <div
          className="absolute bottom-full right-0 z-30 mb-2 w-60 rounded-[9px] border p-2.5 shadow-lg"
          style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        >
          <PanelHeader accountLabel={data?.accountLabel} plan={data?.plan} />
          {rows.length === 0 ? (
            <EmptyUsagePanel />
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                {rows.map(([label, window]) => (
                  <WindowRow key={label} label={label} window={window} dimmed={!isFresh(data?.fetchedAt)} />
                ))}
              </div>
              <PanelFooter fetchedAt={data?.fetchedAt} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
