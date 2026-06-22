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

/** FEAT / FIX / EVENT mono badge. */
export function KindBadge({ kind, className }: { kind: ThreadKind; className?: string }) {
  const meta = KIND_META[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em]',
        className,
      )}
      style={{
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      {meta.label}
    </span>
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
