'use client';

import { useOrgUsage } from '@/lib/api/orgs';
import type { WireOrgUsage } from '@/lib/api/types';
import { formatClockTime } from '@/utils/org-display';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type UsageWindow = WireOrgUsage['fiveHour'];
/** A panel row's window data — the fixed windows plus the per-model ones (whose `resetsAt` may be null). */
type PanelWindow = { utilization: number; resetsAt: string | null };
type RingVisualState = 'active' | 'pending' | 'degraded';
/**
 * Why an always-on row (Session/Weekly) has no data: `waiting` = the endpoint responded but that window
 * hasn't started this cycle (its 5h/7d clock only ticks once a message is sent); `unavailable` = the
 * endpoint itself gave no usable response. The two read differently so a real outage isn't mistaken for
 * an idle account. Dynamic rows (Opus/Sonnet/per-model) are simply omitted when absent, never "unknown".
 */
type UnknownReason = 'waiting' | 'unavailable';
/** One panel row: a known window, or an always-on row with no data yet (Session/Weekly only).
 *  `windowMs` is the window's nominal length, used only to place the pace marker. */
type PanelRow = {
  label: string;
  window: PanelWindow | null;
  unknown: UnknownReason | null;
  windowMs: number;
};

const RING_R = 7;
const RING_CIRC = 2 * Math.PI * RING_R;
const RING_STROKE = 2.2;

const SESSION_WARNING_THRESHOLD = 0.7;
/** ≥ this turns the session arc + % label the "critical" red — a warning colour, NOT the maxed-out dot. */
const SESSION_LIMIT_THRESHOLD = 0.9;
/** The center dot means "usage limit actually hit" — only at a full 100% window, never merely close to it. */
const SESSION_MAXED_THRESHOLD = 1;
const WEEKLY_CAPPED_THRESHOLD = 0.95;
/** Weekly grey peaks (darkest in light theme, brightest in dark) at the half-week mark, then holds. */
const WEEKLY_GREY_PEAK_PCT = 0.5;
const WEEKLY_GREY_MIN_MIX = 15;
const WEEKLY_GREY_MAX_MIX = 68;

const FRESHNESS_STALE_MS = 10 * 60_000;
/** Opening the usage card re-fetches at most this often (1/min) — a fresh look without hammering the endpoint. */
const OPEN_REFRESH_THROTTLE_MS = 60_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Nominal window lengths, used only to place the pace marker (the wire payload carries no start/duration).
 *  Session is the 5-hour window; every other window (Weekly, Opus/Sonnet, per-model caps) is 7 days. */
const SESSION_WINDOW_MS = 5 * MS_PER_HOUR;
const WEEKLY_WINDOW_MS = 7 * MS_PER_DAY;

function clampPct(fraction: number): number {
  return Math.min(1, Math.max(0, fraction));
}

/** Accent → accent-2 → red by the shared usage thresholds. Drives BOTH the session arc and every panel row. */
function thresholdColor(pct: number): string {
  if (pct >= SESSION_LIMIT_THRESHOLD) return 'var(--red)';
  if (pct >= SESSION_WARNING_THRESHOLD) return 'var(--accent-2)';
  return 'var(--accent)';
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
  if (pct >= WEEKLY_CAPPED_THRESHOLD) return 'var(--red)';
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
  if (secs < 45) return 'just now';
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
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  const minutes = Math.floor(remainingMs / MS_PER_MINUTE);
  return `${minutes}m`;
}

/**
 * The pace / budget marker position: the fraction of the window's TIME that has elapsed, so a bar fill
 * to the RIGHT of it means usage is running ahead of the clock (over budget) and to the left, behind it.
 * Derived from the window's end (`resetsAt`) and its nominal length, since the payload has no start time.
 * Null (marker hidden) when `resetsAt` is missing/unparseable or the length is non-positive.
 */
function paceFraction(
  resetsAt: string | null | undefined,
  windowMs: number,
  now: number = Date.now(),
): number | null {
  if (!resetsAt || windowMs <= 0) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  return clampPct(1 - (target - now) / windowMs);
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
  const weekday = target.toLocaleDateString(undefined, { weekday: 'short' });
  const monthDay = target.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const time = target.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${weekday}, ${monthDay} · ${time}`;
}

function firstLetter(label: string): string {
  return label.trim().charAt(0).toUpperCase() || '?';
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
  maxed,
  size,
}: {
  state: RingVisualState;
  sessionPct: number;
  weeklyPct: number;
  /** Draw the center dot — true ONLY at a maxed-out (100%) window, not merely near the limit. */
  maxed: boolean;
  size: number;
}) {
  if (state === 'degraded') {
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

  if (state === 'pending') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
        <circle
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          stroke="var(--border)"
          strokeWidth={RING_STROKE}
        />
        <circle cx="9" cy="9" r={1.4} fill="var(--faint)" opacity={0.45} />
      </svg>
    );
  }

  // The arc always reflects the ACTUAL utilization (a near-max window is drawn as it is, not force-filled),
  // coloured red by the shared thresholds from 90% up. The maxed-out center dot is the only "limit hit" mark.
  const sessionColor = thresholdColor(sessionPct);
  const sessionDasharray = `${RING_CIRC * sessionPct} ${RING_CIRC}`;

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
      {maxed ? <circle cx="9" cy="9" r={1.5} fill="var(--red)" /> : null}
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
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
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
          style={{ borderColor: 'var(--border)' }}
        >
          {plan}
        </span>
      ) : null}
    </div>
  );
}

/** An always-on row (Session/Weekly) with no window data — a muted "Waiting for next turn" (endpoint OK,
 *  window not started) or amber "Usage unavailable" (endpoint gave no response). Same shape as a known
 *  row so the panel never jumps: label + dot, a dashed/hollow bar instead of a fill, and the reason in
 *  place of a reset line. */
function UnknownRow({ label, reason }: { label: string; reason: UnknownReason }) {
  const unavailable = reason === 'unavailable';
  const accent = unavailable ? 'var(--accent-2)' : 'var(--faint)';
  const text = unavailable ? 'Usage unavailable' : 'Waiting for next turn';
  return (
    <div className="flex flex-col gap-1 opacity-80">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: accent }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums" style={{ color: accent }}>
          —
        </span>
      </div>
      <div
        className="h-[3px] w-full rounded-full"
        style={{
          backgroundImage: `repeating-linear-gradient(90deg, ${accent} 0 4px, transparent 4px 8px)`,
          opacity: unavailable ? 0.8 : 0.45,
        }}
      />
      <div className="text-[10px]" style={{ color: accent }}>
        {text}
      </div>
    </div>
  );
}

/** One window's row in the usage panel — a colored dot + label, a thin progress bar, and a reset line.
 *  Only rendered for windows we have data for; `dimmed` mutes a stale (not-fresh) snapshot's rows. */
function WindowRow({
  label,
  window,
  windowMs,
  dimmed,
}: {
  label: string;
  window: PanelWindow;
  windowMs: number;
  dimmed: boolean;
}) {
  const pct = clampPct(window.utilization / 100);
  const color = thresholdColor(pct);
  const countdown = formatCountdown(window.resetsAt ?? undefined);
  const resetHuman = formatResetHuman(window.resetsAt ?? undefined);
  // Where usage "should be" by now, from the fraction of the window's time elapsed. A fill past this
  // marker is over budget (burning faster than the clock). Hidden when there's no reset time to anchor it.
  const pace = paceFraction(window.resetsAt, windowMs);
  return (
    <div className={`flex flex-col gap-1 ${dimmed ? 'opacity-70' : ''}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: color }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {Math.round(window.utilization)}%{countdown ? ` · ${countdown}` : ''}
        </span>
      </div>
      <div className="relative h-[3px] w-full rounded-full bg-border">
        <div
          className="h-full overflow-hidden rounded-full"
          style={{ width: `${pct * 100}%`, background: color }}
        />
        {pace != null ? (
          <div
            aria-hidden
            className="absolute top-1/2 h-[7px] w-px -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${pace * 100}%`,
              background: 'var(--red)',
              boxShadow: '0 0 0 1px var(--surface-2)',
            }}
          />
        ) : null}
      </div>
      {resetHuman ? <div className="text-[10px] text-faint">resets {resetHuman}</div> : null}
    </div>
  );
}

/** Panel footer — a freshness dot + status. When the endpoint gave no response (`unavailable`) it says
 *  so in amber; otherwise the last-fetched relative time (green when fresh, amber when stale). */
function PanelFooter({
  fetchedAt,
  unavailable,
}: {
  fetchedAt: string | undefined;
  unavailable: boolean;
}) {
  const fresh = !unavailable && isFresh(fetchedAt);
  return (
    <div
      className="mt-2.5 flex items-center gap-1.5 border-t pt-1.5"
      style={{ borderColor: 'var(--border)' }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: fresh ? 'var(--green)' : 'var(--accent-2)' }}
      />
      <span
        className="font-mono text-[10px]"
        style={{ color: fresh ? 'var(--faint)' : 'var(--accent-2)' }}
      >
        {unavailable ? 'Usage unavailable' : `Updated ${timeAgo(fetchedAt) ?? 'recently'}`}
      </span>
    </div>
  );
}

/**
 * A subscription-usage ring (Claude Code `/usage` style) — the SESSION (5-hour) window as a small SVG arc
 * + %, with the WEEKLY (7-day) window as a second arc sharing the same groove behind it. CLICK it to open
 * a panel: Session and Weekly are ALWAYS listed (as an unknown row when they have no data yet), and
 * Opus/Sonnet/per-model caps are listed dynamically when present. The ring always stays visible, with
 * dedicated "pending" (responded, not started) and "degraded" (unavailable) states — the usage endpoint
 * is best-effort and must never block or error its host surface (the composer footer, or a Settings
 * credential card).
 */
export function UsageRingView({
  data,
  isLoading,
  size = 17,
  refetch,
  dataUpdatedAt,
}: {
  data: WireOrgUsage | undefined;
  isLoading: boolean;
  size?: number;
  /** Optional on-open refresh: the owning hook's `refetch` + `dataUpdatedAt` (throttled to 1/min). */
  refetch?: () => void;
  dataUpdatedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel is anchored to the right of a trigger that sits mid-composer, so on a narrow (mobile)
  // viewport its fixed width overflows past the left screen edge. Measure once open and nudge it back
  // on-screen with a small horizontal offset; 0 on desktop, where it already fits.
  const [shiftX, setShiftX] = useState(0);

  // Refresh-on-open: opening the panel re-fetches usage on the spot, but at most once per minute (skipped
  // when the data is already newer than that). Read via a ref so this fires only on the open transition,
  // not every time the cache updates. The backend also floors its live fetch at 1/min, so this can't spam.
  const usageMeta = useRef({ refetch, dataUpdatedAt });
  usageMeta.current = { refetch, dataUpdatedAt };
  useEffect(() => {
    if (!open) return;
    const { refetch: doRefetch, dataUpdatedAt: lastAt } = usageMeta.current;
    if (doRefetch && Date.now() - (lastAt ?? 0) >= OPEN_REFRESH_THROTTLE_MS) doRefetch();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Keep the panel within the viewport. Read the panel's natural left edge (subtracting any offset
  // already applied) and, if it clips either side, shift it just enough to sit inside an 8px margin.
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
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // `shiftX` is intentionally omitted: it's derived here, and re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const session = data?.fiveHour ?? null;
  const weekly = data?.sevenDay ?? null;
  // The endpoint gave a usable response iff we have a snapshot that isn't the degraded (`ok:false`) shape.
  // A fresh account returns `ok:true` with every fixed window null — that's "responded, not started yet",
  // NOT an outage — so its empty Session/Weekly rows read "Waiting for next turn", while a real failure
  // reads "Usage unavailable". A first load with no cache yet (no data, still fetching) is treated as
  // pending too, so it doesn't flash "unavailable" before the response lands.
  const responded = data ? data.ok !== false : isLoading;
  const unknownReason: UnknownReason = responded ? 'waiting' : 'unavailable';

  // Session (5h) and Weekly (7d) are ALWAYS shown; when their window is absent they render as an unknown
  // row rather than being hidden. Opus/Sonnet and the per-model weekly caps (e.g. Fable) stay dynamic —
  // present only when the endpoint reports them.
  const alwaysOnRows: PanelRow[] = [
    {
      label: 'Session · 5h',
      window: session,
      unknown: session ? null : unknownReason,
      windowMs: SESSION_WINDOW_MS,
    },
    {
      label: 'Weekly · all models · 7d',
      window: weekly,
      unknown: weekly ? null : unknownReason,
      windowMs: WEEKLY_WINDOW_MS,
    },
  ];
  const dynamicRows: PanelRow[] = (
    [
      ['Opus · 7d', data?.sevenDayOpus ?? null],
      ['Sonnet · 7d', data?.sevenDaySonnet ?? null],
    ] as [string, UsageWindow][]
  )
    .filter((row): row is [string, NonNullable<UsageWindow>] => row[1] !== null)
    .map(
      ([label, w]) =>
        ({
          label,
          window: w,
          unknown: null,
          windowMs: WEEKLY_WINDOW_MS,
        }) satisfies PanelRow,
    );
  const modelRows: PanelRow[] = (data?.modelWindows ?? []).map((w) => ({
    label: `${w.label} · 7d`,
    window: { utilization: w.utilization, resetsAt: w.resetsAt },
    unknown: null,
    windowMs: WEEKLY_WINDOW_MS,
  }));
  const rows: PanelRow[] = [...alwaysOnRows, ...dynamicRows, ...modelRows];

  const sessionPct = session ? clampPct(session.utilization / 100) : 0;
  const weeklyPct = weekly ? clampPct(weekly.utilization / 100) : 0;
  // The ring draws real arcs whenever session OR weekly has data; `pending` (fresh, not started) shows a
  // clean outline; `degraded` (unavailable) shows a dashed one.
  const visualState: RingVisualState =
    session || weekly ? 'active' : responded ? 'pending' : 'degraded';

  // `maxed` (100%) lights the limit-hit dot for EITHER window — a capped weekly blocks you just as hard as
  // a capped session. When maxed, the ring's label becomes a countdown to the soonest reset among the
  // windows that are actually maxed (when you first get headroom back), instead of a bare "100%".
  const sessionMaxed = sessionPct >= SESSION_MAXED_THRESHOLD;
  const weeklyMaxed = weeklyPct >= SESSION_MAXED_THRESHOLD;
  const maxed = sessionMaxed || weeklyMaxed;
  const maxedResets = [
    sessionMaxed ? session?.resetsAt : null,
    weeklyMaxed ? weekly?.resetsAt : null,
  ].filter((iso): iso is string => !!iso);
  const soonestMaxedReset = maxedResets.length
    ? maxedResets.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b))
    : undefined;
  const maxedCountdown = maxed ? formatCountdown(soonestMaxedReset) : null;

  // `critical` is the red treatment on the label: a maxed window, or a session heading into its cap.
  const critical = maxed || (!!session && sessionPct >= SESSION_LIMIT_THRESHOLD);

  // Before the first turn of a reset session, the 5h window has no data yet ("waiting for next turn"),
  // but usage is genuinely 0% — so show "0%" rather than a bare middot that reads as broken. Only a real
  // endpoint failure (not responded) falls through to the "–" placeholder.
  const labelText = maxedCountdown
    ? maxedCountdown
    : session
      ? `${Math.round(sessionPct * 100)}%`
      : responded
        ? '0%'
        : '–';
  const labelClassName = critical ? '' : session || responded ? 'text-dim' : 'text-faint';
  const labelStyle = critical ? { color: 'var(--red)' } : undefined;

  const title = maxedCountdown
    ? `Claude usage · limit reached — resets in ${maxedCountdown} — click for details`
    : session
      ? `Session usage · ${Math.round(sessionPct * 100)}% (resets ${formatClockTime(
          session.resetsAt,
        )}) — click for details`
      : responded
        ? 'Session usage · 0% — waiting for next turn — click for details'
        : 'Claude usage · unavailable right now — click for details';

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
        <Ring
          state={visualState}
          sessionPct={sessionPct}
          weeklyPct={weeklyPct}
          maxed={maxed}
          size={size}
        />
        <span className={`font-mono text-[10px] tabular-nums ${labelClassName}`} style={labelStyle}>
          {labelText}
        </span>
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="absolute bottom-full right-0 z-30 mb-2 w-60 max-w-[calc(100vw-1rem)] rounded-[9px] border p-2.5 shadow-lg"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-2)',
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
          }}
        >
          <PanelHeader accountLabel={data?.accountLabel} plan={data?.plan} />
          <div className="flex flex-col gap-2.5">
            {rows.map((row) =>
              row.window ? (
                <WindowRow
                  key={row.label}
                  label={row.label}
                  window={row.window}
                  windowMs={row.windowMs}
                  dimmed={!isFresh(data?.fetchedAt)}
                />
              ) : (
                <UnknownRow
                  key={row.label}
                  label={row.label}
                  reason={row.unknown ?? unknownReason}
                />
              ),
            )}
          </div>
          <PanelFooter fetchedAt={data?.fetchedAt} unavailable={!responded} />
        </div>
      ) : null}
    </div>
  );
}

/** The composer footer's ring — the org's Claude subscription usage snapshot. */
export function UsageRing({ orgId, size = 17 }: { orgId: string; size?: number }) {
  const { data, isLoading, refetch, dataUpdatedAt } = useOrgUsage(orgId);
  return (
    <UsageRingView
      data={data}
      isLoading={isLoading}
      size={size}
      refetch={refetch}
      dataUpdatedAt={dataUpdatedAt}
    />
  );
}
