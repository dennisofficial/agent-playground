'use client';

import {
  useGetAgentCredentialsQuery,
  useRefreshAgentCredentialUsageMutation,
} from '@/redux/query/api/agent-credentials.api';
import { formatClockTime } from '@/utils/org-display';
import {
  buildAgentCredentialView,
  EAgentCredentialKind,
  EAgentProvider,
  OrgUsage,
  type AgentCredentialView,
} from '@workspace/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type UsageWindow = OrgUsage['fiveHour'];
type PanelWindow = { utilization: number; resetsAt: string | null };
type RingVisualState = 'active' | 'pending' | 'degraded';
type UnknownReason = 'waiting' | 'unavailable';
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
const SESSION_LIMIT_THRESHOLD = 0.9;
const SESSION_MAXED_THRESHOLD = 1;
const WEEKLY_CAPPED_THRESHOLD = 0.95;
const WEEKLY_GREY_PEAK_PCT = 0.5;
const WEEKLY_GREY_MIN_MIX = 15;
const WEEKLY_GREY_MAX_MIX = 68;

const FRESHNESS_STALE_MS = 10 * 60_000;
const OPEN_REFRESH_THROTTLE_MS = 60_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const SESSION_WINDOW_MS = 5 * MS_PER_HOUR;
const WEEKLY_WINDOW_MS = 7 * MS_PER_DAY;

function clampPct(fraction: number): number {
  return Math.min(1, Math.max(0, fraction));
}

function thresholdColor(pct: number): string {
  if (pct >= SESSION_LIMIT_THRESHOLD) return 'var(--red)';
  if (pct >= SESSION_WARNING_THRESHOLD) return 'var(--accent-2)';
  return 'var(--accent)';
}

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
          className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full font-mono text-[9px] font-semibold"
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
          className="shrink-0 rounded-[4px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-faint"
          style={{ borderColor: 'var(--border)' }}
        >
          {plan}
        </span>
      ) : null}
    </div>
  );
}

function UnknownRow({ label, reason }: { label: string; reason: UnknownReason }) {
  const unavailable = reason === 'unavailable';
  const accent = unavailable ? 'var(--accent-2)' : 'var(--faint)';
  const text = unavailable ? 'Usage unavailable' : 'Waiting for next turn';
  return (
    <div className="flex flex-col gap-1 opacity-80">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          <span className="h-1.5 w-1.5 shrink-0 rounded-xs" style={{ background: accent }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums" style={{ color: accent }}>
          —
        </span>
      </div>
      <div
        className="h-0.75 w-full rounded-full"
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
          <span className="h-1.5 w-1.5 shrink-0 rounded-xs" style={{ background: color }} />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {Math.round(window.utilization)}%{countdown ? ` · ${countdown}` : ''}
        </span>
      </div>
      <div className="relative h-0.75 w-full rounded-full bg-border">
        <div
          className="h-full overflow-hidden rounded-full"
          style={{ width: `${pct * 100}%`, background: color }}
        />
        {pace != null ? (
          <div
            aria-hidden
            className="absolute top-1/2 h-1.75 w-px -translate-x-1/2 -translate-y-1/2 rounded-full"
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

export function UsageRingView({
  data,
  isLoading,
  size = 17,
  refetch,
  dataUpdatedAt,
}: {
  data: OrgUsage | undefined;
  isLoading: boolean;
  size?: number;
  /** Optional on-open refresh: the owning hook's `refetch` + `dataUpdatedAt` (throttled to 1/min). */
  refetch?: () => void;
  dataUpdatedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shiftX, setShiftX] = useState(0);

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
  }, [open]);

  const session = data?.fiveHour ?? null;
  const weekly = data?.sevenDay ?? null;
  const responded = data ? data.ok !== false : isLoading;
  const unknownReason: UnknownReason = responded ? 'waiting' : 'unavailable';

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
  const visualState: RingVisualState =
    session || weekly ? 'active' : responded ? 'pending' : 'degraded';

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

  const critical = maxed || (!!session && sessionPct >= SESSION_LIMIT_THRESHOLD);

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

export function accountToRingData(cred: AgentCredentialView): OrgUsage | undefined {
  if (!cred.usage) return undefined;
  return {
    ...cred.usage,
    accountLabel: cred.accountEmail ?? undefined,
    plan: cred.plan ?? undefined,
  };
}

export function UsageRing({ orgId, size = 17 }: { orgId: string; size?: number }) {
  const { data: raw, isLoading } = useGetAgentCredentialsQuery(orgId, { skip: !orgId });
  const [refreshUsage] = useRefreshAgentCredentialUsageMutation();

  const selected = useMemo(
    () =>
      raw
        ?.map(buildAgentCredentialView)
        .find((c) => c.provider === EAgentProvider.CLAUDE && c.selected),
    [raw],
  );

  const refetch = useCallback(() => {
    if (!selected || selected.kind !== EAgentCredentialKind.PERSONAL) return;
    void refreshUsage({ orgId, id: selected.id })
      .unwrap()
      .catch(() => {});
  }, [orgId, refreshUsage, selected]);

  const data = selected ? accountToRingData(selected) : undefined;
  return (
    <UsageRingView
      data={data}
      isLoading={isLoading}
      size={size}
      refetch={refetch}
      dataUpdatedAt={data ? Date.parse(data.fetchedAt) : 0}
    />
  );
}
