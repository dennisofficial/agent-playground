import { EJobKind, EJobStatus, EStepStatus } from '@workspace/shared';

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

export const STATUS_META: Record<EJobStatus, StatusMeta> = {
  [EJobStatus.OPEN]: { label: 'Open', color: 'var(--slate)', pulse: false },
  [EJobStatus.RUNNING]: { label: 'Running', color: 'var(--accent)', pulse: true },
  [EJobStatus.PLANNING]: { label: 'Planning', color: 'var(--blue)', pulse: false },
  // Codex reviewing the submitted plan — still the pre-approval, you're-in-the-loop phase (NOT the
  // autonomous post-approval build), so it reads blue like Planning, never the orange Running accent.
  [EJobStatus.PLAN_REVIEW]: { label: 'Reviewing', color: 'var(--blue)', pulse: true },
  // One muted slate covers every "needs you" gate (handoff: restrained palette).
  [EJobStatus.AWAITING_APPROVAL]: {
    label: 'Awaiting approval',
    color: 'var(--slate)',
    pulse: false,
  },
  // The SECOND human gate — the build + master review are done; the operator just needs to eyeball the
  // diff and click "Ship it". Same restrained slate as every other "needs you" gate.
  [EJobStatus.AWAITING_SHIP_REVIEW]: {
    label: 'Ready to ship',
    color: 'var(--slate)',
    pulse: false,
  },
  // Ship review was retracted — the built work is being amended, not re-planned. Same restrained slate
  // dot as every other "needs you" gate (the amber lives on the sidebar GROUP swatch, not the row dot).
  [EJobStatus.AMENDING]: { label: 'Amending', color: 'var(--slate)', pulse: false },
  // Parked waiting on a blocker job's PR to merge — the system owns the next step, not the operator, so
  // it gets the dedicated warning amber (the merge-conflict glyph's hue) rather than the "needs you" slate.
  [EJobStatus.BLOCKED]: { label: 'Blocked', color: 'var(--amber)', pulse: false },
  [EJobStatus.DONE]: { label: 'Done', color: 'var(--green)', pulse: false },
  [EJobStatus.CANCELLED]: { label: 'Cancelled', color: 'var(--faint)', pulse: false },
  // Transient: the job is being torn down and will vanish from the list momentarily.
  [EJobStatus.DELETING]: { label: 'Deleting…', color: 'var(--faint)', pulse: true },
  // Terminal, read-only: the job has left the active list for the archive.
  [EJobStatus.ARCHIVED]: { label: 'Archived', color: 'var(--faint)', pulse: false },
};

export interface KindMeta {
  label: string;
  color: string;
}

export const KIND_META: Record<EJobKind, KindMeta> = {
  [EJobKind.FEATURE]: { label: 'FEAT', color: 'var(--dim)' },
  [EJobKind.BUGFIX]: { label: 'FIX', color: 'var(--dim)' },
  [EJobKind.EVENT]: { label: 'EVENT', color: 'var(--dim)' },
  [EJobKind.ONBOARDING]: { label: 'INIT', color: 'var(--dim)' },
  [EJobKind.REVIEW]: { label: 'REVIEW', color: 'var(--dim)' },
};

const PHASE_LABEL: Record<EStepStatus, string> = {
  pending: 'pending',
  building: 'building',
  reviewing: 'reviewing',
  done: 'done',
};

export function phaseLabel(status: EStepStatus): string {
  return PHASE_LABEL[status];
}
