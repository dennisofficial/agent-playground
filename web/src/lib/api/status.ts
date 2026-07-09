import type {
  WireJobKind,
  WireJobStatus,
  JobKind,
  JobStatus,
  StepStatus,
  ThreadStatus,
} from "./types";

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

export const STATUS_META: Record<JobStatus, StatusMeta> = {
  running: { label: "Running", color: "var(--accent)", pulse: true },
  planning: { label: "Planning", color: "var(--blue)", pulse: false },
  // Codex reviewing the submitted plan — still the pre-approval, you're-in-the-loop phase (NOT the
  // autonomous post-approval build), so it reads blue like Planning, never the orange Running accent.
  plan_review: { label: "Reviewing", color: "var(--blue)", pulse: true },
  // One muted slate covers every "needs you" gate (handoff: restrained palette).
  awaiting_approval: {
    label: "Awaiting approval",
    color: "var(--slate)",
    pulse: false,
  },
  // The SECOND human gate — the build + master review are done; the operator just needs to eyeball the
  // diff and click "Ship it". Same restrained slate as every other "needs you" gate.
  awaiting_ship_review: {
    label: "Ready to ship",
    color: "var(--slate)",
    pulse: false,
  },
  done: { label: "Done", color: "var(--green)", pulse: false },
  triaging: { label: "Triaging", color: "var(--slate)", pulse: true },
  cancelled: { label: "Cancelled", color: "var(--faint)", pulse: false },
  // Transient: the job is being torn down and will vanish from the list momentarily.
  deleting: { label: "Deleting…", color: "var(--faint)", pulse: true },
};

export interface KindMeta {
  label: string;
  color: string;
}

/** Kind badges are NEUTRAL grey (handoff: do not reintroduce per-kind color). */
export const KIND_META: Record<JobKind, KindMeta> = {
  feat: { label: "FEAT", color: "var(--dim)" },
  fix: { label: "FIX", color: "var(--dim)" },
  event: { label: "EVENT", color: "var(--dim)" },
  onboard: { label: "INIT", color: "var(--dim)" },
  review: { label: "REVIEW", color: "var(--dim)" },
};

/** Wire JobStatus → UI JobStatus. */
export function toJobStatus(status: WireJobStatus): JobStatus {
  switch (status) {
    case "running":
      return "running";
    case "planning":
      return "planning";
    case "plan_review":
      return "plan_review";
    case "awaiting_approval":
      return "awaiting_approval";
    case "awaiting_ship_review":
      return "awaiting_ship_review";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "deleting":
      return "deleting";
    default:
      return "planning";
  }
}

/** Wire JobKind → UI JobKind. `null`/unknown (a job not yet scoped) reads as `feat`. */
export function toJobKind(kind: WireJobKind | null | undefined): JobKind {
  switch (kind) {
    case "bugfix":
      return "fix";
    case "onboarding":
      return "onboard";
    case "event":
      return "event";
    case "review":
      return "review";
    default:
      return "feat";
  }
}

/** Per-thread dot color for the navigator pipeline tree. */
export function threadColor(status: ThreadStatus): {
  color: string;
  pulse: boolean;
} {
  switch (status) {
    case "done":
      return { color: "var(--green)", pulse: false };
    case "executing":
    case "planning":
    case "reviewing":
    case "auto_fixing":
      return { color: "var(--accent)", pulse: true };
    case "awaiting_approval":
    // A mid-build `request_operator_input` pause — same muted "needs you" slate as awaiting_approval.
    case "awaiting_input":
      return { color: "var(--slate)", pulse: false };
    case "failed":
      return { color: "var(--red)", pulse: false };
    // Halted without asserting completion (ADR 0004) — a needs-attention amber, distinct from a crash (red).
    case "incomplete":
      return { color: "var(--amber)", pulse: false };
    case "pending":
    default:
      return { color: "var(--border-2)", pulse: false };
  }
}

/**
 * Per-step / per-session dot for the navigator's execute-folder leaves. Same dot grammar as threads
 * (handoff §Dots): active = accent + pulse, done = green, failed = red, skipped = faint, pending = the
 * neutral pending dot. `skipped` is rendered as a hollow ring + strikethrough at the call site.
 */
export function stepColor(status: StepStatus): {
  color: string;
  pulse: boolean;
} {
  switch (status) {
    case "done":
      return { color: "var(--green)", pulse: false };
    case "building":
    case "reviewing":
      return { color: "var(--accent)", pulse: true };
    case "failed":
      return { color: "var(--red)", pulse: false };
    case "skipped":
      return { color: "var(--faint)", pulse: false };
    case "pending":
    default:
      return { color: "var(--border-2)", pulse: false };
  }
}

const PHASE_LABEL: Record<StepStatus, string> = {
  pending: "pending",
  building: "building",
  reviewing: "reviewing",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

export function phaseLabel(status: StepStatus): string {
  return PHASE_LABEL[status];
}
