import type {
  JobKind,
  JobStatus,
  SectionStatus,
  ThreadKind,
  ThreadStatus,
} from './types';

/**
 * Semantic status → presentation, straight from handoff §7. `color` is a CSS variable name so the
 * theme swap recolors everything for free; `pulse` drives the `softpulse` dot animation.
 */
export interface StatusMeta {
  label: string;
  /** CSS custom property (e.g. `var(--accent)`). */
  color: string;
  pulse: boolean;
}

export const STATUS_META: Record<ThreadStatus, StatusMeta> = {
  running: { label: 'Running', color: 'var(--accent)', pulse: true },
  scoping: { label: 'Scoping', color: 'var(--blue)', pulse: false },
  awaiting_approval: { label: 'Awaiting approval', color: 'var(--purple)', pulse: false },
  done: { label: 'Done', color: 'var(--green)', pulse: false },
  triaging: { label: 'Triaging', color: 'var(--rose)', pulse: true },
  paused: { label: 'Paused', color: 'var(--faint)', pulse: false },
  failed: { label: 'Failed', color: 'var(--red)', pulse: false },
};

export interface KindMeta {
  label: string;
  color: string;
}

export const KIND_META: Record<ThreadKind, KindMeta> = {
  feat: { label: 'FEAT', color: 'var(--accent)' },
  fix: { label: 'FIX', color: 'var(--purple)' },
  event: { label: 'EVENT', color: 'var(--rose)' },
};

/** Backend JobStatus → UI ThreadStatus. (`cancelled` reads as paused-terminal in the UI.) */
export function toThreadStatus(status: JobStatus): ThreadStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'scoping':
      return 'scoping';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'done':
      return 'done';
    case 'paused':
    case 'cancelled':
      return 'paused';
    case 'failed':
      return 'failed';
    default:
      return 'scoping';
  }
}

/** Backend JobKind → UI ThreadKind (event threads are tagged at the stimulus layer, not JobKind). */
export function toThreadKind(kind: JobKind): ThreadKind {
  return kind === 'bugfix' ? 'fix' : 'feat';
}

/** Per-section dot color for the navigator pipeline tree. */
export function sectionColor(status: SectionStatus): { color: string; pulse: boolean } {
  switch (status) {
    case 'done':
      return { color: 'var(--green)', pulse: false };
    case 'executing':
    case 'planning':
    case 'reviewing':
    case 'auto_fixing':
      return { color: 'var(--accent)', pulse: true };
    case 'awaiting_approval':
      return { color: 'var(--purple)', pulse: false };
    case 'failed':
      return { color: 'var(--red)', pulse: false };
    case 'pending':
    default:
      return { color: 'var(--faint)', pulse: false };
  }
}
