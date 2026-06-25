import type {
  JobKind,
  JobStatus,
  PhaseStatus,
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
  // One muted slate covers every "needs you" gate (handoff: restrained palette).
  awaiting_approval: { label: 'Awaiting approval', color: 'var(--slate)', pulse: false },
  done: { label: 'Done', color: 'var(--green)', pulse: false },
  triaging: { label: 'Triaging', color: 'var(--slate)', pulse: true },
  paused: { label: 'Paused', color: 'var(--faint)', pulse: false },
  failed: { label: 'Failed', color: 'var(--red)', pulse: false },
};

export interface KindMeta {
  label: string;
  color: string;
}

/** Kind badges are NEUTRAL grey (handoff: do not reintroduce per-kind color). */
export const KIND_META: Record<ThreadKind, KindMeta> = {
  feat: { label: 'FEAT', color: 'var(--dim)' },
  fix: { label: 'FIX', color: 'var(--dim)' },
  event: { label: 'EVENT', color: 'var(--dim)' },
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
      return { color: 'var(--slate)', pulse: false };
    case 'failed':
      return { color: 'var(--red)', pulse: false };
    case 'pending':
    default:
      return { color: 'var(--border-2)', pulse: false };
  }
}

/**
 * Per-phase / per-session dot for the navigator's execute-folder leaves. Same dot grammar as sections
 * (handoff §Dots): active = accent + pulse, done = green, failed = red, skipped = faint, pending = the
 * neutral pending dot. `skipped` is rendered as a hollow ring + strikethrough at the call site.
 */
export function phaseColor(status: PhaseStatus): { color: string; pulse: boolean } {
  switch (status) {
    case 'done':
      return { color: 'var(--green)', pulse: false };
    case 'building':
    case 'reviewing':
      return { color: 'var(--accent)', pulse: true };
    case 'failed':
      return { color: 'var(--red)', pulse: false };
    case 'skipped':
      return { color: 'var(--faint)', pulse: false };
    case 'pending':
    default:
      return { color: 'var(--border-2)', pulse: false };
  }
}

const PHASE_LABEL: Record<PhaseStatus, string> = {
  pending: 'pending',
  building: 'building',
  reviewing: 'reviewing',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

export function phaseLabel(status: PhaseStatus): string {
  return PHASE_LABEL[status];
}
