import { cn } from '@/lib/cn';
import { KIND_META, STATUS_META } from '@/lib/api/status';
import type { ThreadKind, ThreadStatus } from '@/lib/api/types';

/** A status dot — colored by status, optionally pulsing (running/triaging) with a soft glow. */
export function StatusDot({
  status,
  size = 8,
  className,
}: {
  status: ThreadStatus;
  size?: number;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', meta.pulse && 'pulse-dot', className)}
      style={{
        width: size,
        height: size,
        background: meta.color,
        boxShadow: meta.pulse ? `0 0 0 3px color-mix(in srgb, ${meta.color} 18%, transparent)` : undefined,
      }}
      aria-hidden
    />
  );
}

/** A plain colored dot (used for section nodes + system-event tones). */
export function Dot({
  color,
  pulse = false,
  size = 8,
  className,
}: {
  color: string;
  pulse?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', pulse && 'pulse-dot', className)}
      style={{ width: size, height: size, background: color }}
      aria-hidden
    />
  );
}

/** FEAT / FIX / EVENT mono badge — NEUTRAL grey + hairline border (handoff: no per-kind color). */
export function KindBadge({ kind, className }: { kind: ThreadKind; className?: string }) {
  const meta = KIND_META[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[3px] border border-border-2 px-[5px] py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.06em] text-dim',
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

/**
 * Status "pie" — a ring whose fill encodes the thread's stage (ported from the design's `pie()`):
 * raw (scoping/triaging) = dashed ring, open (approval/paused/failed) = solid ring, progress
 * (running) = ring + half arc, done = filled accent disc. `status` undefined → a neutral hollow ring
 * (the cross-org inbox carries no status for most rows yet — see `inbox.ts`).
 */
const STATUS_STAGE: Record<ThreadStatus, 'raw' | 'open' | 'progress' | 'done'> = {
  scoping: 'raw',
  triaging: 'raw',
  plan_review: 'progress',
  awaiting_approval: 'open',
  paused: 'open',
  failed: 'open',
  running: 'progress',
  done: 'done',
};

export function StatusPie({ status, size = 14 }: { status?: ThreadStatus; size?: number }) {
  const stage = status ? STATUS_STAGE[status] : 'open';
  const r = 8;
  const circ = 2 * Math.PI * r;
  const ring = (color: string, dashed = false) => (
    <circle
      cx={10}
      cy={10}
      r={r}
      fill="none"
      stroke={color}
      strokeWidth={2.4}
      strokeDasharray={dashed ? '2.2 3' : undefined}
      strokeLinecap={dashed ? 'round' : undefined}
    />
  );
  let kids: React.ReactNode;
  if (stage === 'raw') {
    kids = ring('var(--border-2)', true);
  } else if (stage === 'progress') {
    kids = (
      <>
        {ring('var(--border-2)')}
        <circle
          cx={10}
          cy={10}
          r={r}
          fill="none"
          stroke="var(--text)"
          strokeWidth={2.4}
          strokeDasharray={circ}
          strokeDashoffset={circ * 0.5}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
        />
      </>
    );
  } else if (stage === 'done') {
    kids = (
      <>
        {ring('var(--accent)')}
        <circle cx={10} cy={10} r={5.4} fill="var(--accent)" />
      </>
    );
  } else {
    kids = ring('var(--border-2)');
  }
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="block shrink-0" aria-hidden>
      {kids}
    </svg>
  );
}

/** Status pill: a dot + label, tinted by status. */
export function StatusPill({ status, className }: { status: ThreadStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        className,
      )}
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} 30%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
      }}
    >
      <StatusDot status={status} size={6} />
      {meta.label}
    </span>
  );
}
