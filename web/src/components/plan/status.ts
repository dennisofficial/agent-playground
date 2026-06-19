/**
 * Shared status → color mapping for board tasks, pipeline runs, sections, and phases. Keeps the
 * header badge, the section timeline, and the dependency graph reading the same palette.
 */
export type StatusTone = 'done' | 'active' | 'pending' | 'failed' | 'blocked' | 'neutral';

const STATUS_TONE: Record<string, StatusTone> = {
  // terminal / success
  done: 'done',
  complete: 'done',
  approved: 'done',
  reviewed: 'done',
  // in-flight
  building: 'active',
  reviewing: 'active',
  planning: 'active',
  executing: 'active',
  running: 'active',
  self_review: 'active',
  in_review: 'active',
  awaiting_approval: 'active',
  // not started
  pending: 'pending',
  open: 'pending',
  skipped: 'neutral',
  paused: 'neutral',
  // bad
  failed: 'failed',
  blocked: 'blocked',
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONE[status] ?? 'neutral';
}

/** Tailwind classes for a small pill badge of the given status. */
export function statusBadgeClass(status: string): string {
  switch (statusTone(status)) {
    case 'done':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
    case 'active':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'blocked':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300';
    case 'pending':
      return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
    default:
      return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

/** A hex fill for Mermaid node styling (Mermaid can't read Tailwind classes). */
export function statusHexFill(status: string): string {
  switch (statusTone(status)) {
    case 'done':
      return '#a7f3d0';
    case 'active':
      return '#bfdbfe';
    case 'failed':
      return '#fecaca';
    case 'blocked':
      return '#fde68a';
    default:
      return '#e4e4e7';
  }
}
