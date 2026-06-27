import type { TicketKind, TicketListRow, TicketPriority, TicketStatus } from '@/lib/api/tickets-api';

/** The active board columns (backlog is the separate triage view; cancelled is collapsed in backlog). */
export const BOARD_COLUMNS: TicketStatus[] = ['todo', 'in_progress', 'in_review', 'done'];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Status → dot color (CSS var). Matches the design's `[data-ds]` map. */
export function statusColor(s: TicketStatus): string {
  switch (s) {
    case 'todo':
      return 'var(--blue)';
    case 'in_progress':
      return 'var(--accent)';
    case 'in_review':
      return 'var(--purple)';
    case 'done':
      return 'var(--green)';
    default:
      return 'var(--faint)'; // backlog, cancelled
  }
}

export function priorityColor(p: TicketPriority): string {
  switch (p) {
    case 'urgent':
      return 'var(--red)';
    case 'high':
      return 'var(--accent)';
    case 'medium':
      return 'var(--blue)';
    default:
      return 'var(--faint)';
  }
}

export function kindColor(k: TicketKind): string {
  switch (k) {
    case 'feature':
      return 'var(--accent)';
    case 'bug':
      return 'var(--red)';
    default:
      return 'var(--dim)';
  }
}

export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** A ticket is "Atlas-captured" when it carries provenance (created from a thread / decision). */
export function isAtlasCaptured(t: { originThreadId: string | null; origin: unknown }): boolean {
  return !!t.originThreadId || !!t.origin;
}

/** Client-side board filter (mirrors the design): search + the chip filters. */
export function passesFilter(
  t: TicketListRow,
  q: string,
  filter: 'all' | 'blocked' | 'atlas' | 'urgent',
): boolean {
  const query = q.trim().toLowerCase();
  if (query) {
    const hay = `${t.title} #${t.number} ${t.body ?? ''}`.toLowerCase();
    if (!hay.includes(query)) return false;
  }
  if (filter === 'blocked') return t.blocked;
  if (filter === 'atlas') return isAtlasCaptured(t);
  if (filter === 'urgent') return t.priority === 'urgent';
  return true;
}

/** Compact relative time ("just now", "3h ago", "2d ago") from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
