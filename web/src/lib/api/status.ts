import type {
  WireJobKind,
  WireJobStatus,
  JobKind,
  JobStatus,
  StepStatus,
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
  // The post-build Codex master review — same hands-off "step away" read as plan review, so it shares
  // the blue reviewing treatment rather than the autonomous-build orange.
  master_review: { label: "Reviewing", color: "var(--blue)", pulse: true },
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
  // Ship review was retracted — the built work is being amended, not re-planned. Same restrained slate
  // dot as every other "needs you" gate (the amber lives on the sidebar GROUP swatch, not the row dot).
  amending: { label: "Amending", color: "var(--slate)", pulse: false },
  // Parked waiting on a blocker job's PR to merge — the system owns the next step, not the operator, so
  // it gets the dedicated warning amber (the merge-conflict glyph's hue) rather than the "needs you" slate.
  blocked: { label: "Blocked", color: "var(--amber)", pulse: false },
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

/**
 * Wire JobStatus → the web's UI-presentation JobStatus. The backend enum was widened (`scoping`,
 * `plan_reviewing`, `building`, `master_review`, `ready`, `shipping`, `pr_open`, `merged`); the console
 * keeps its coarser presentation vocab, so several wire values fold onto one presentation dot:
 *  - `building`/`shipping` → the autonomous `running` spinner (a build lane owns the work; `sectionOf`
 *    still splits "Ready to Ship" out via the `shipping` flag);
 *  - `master_review` → its own `master_review` dot, reusing `plan_review`'s hands-off "Reviewing" blue
 *    (kept distinct from `running` so the Inbox can bucket it into its own section, same as before);
 *  - `ready` → the `awaiting_ship_review` gate;
 *  - `pr_open`/`merged` → the terminal `done` dot (the sidebar swaps in the PR glyph from `pr.state`).
 */
export function toJobStatus(status: WireJobStatus): JobStatus {
  switch (status) {
    case "scoping":
    case "planning":
      return "planning";
    case "plan_reviewing":
      return "plan_review";
    case "awaiting_approval":
      return "awaiting_approval";
    case "building":
    case "shipping":
      return "running";
    case "master_review":
      return "master_review";
    case "ready":
      return "awaiting_ship_review";
    case "pr_open":
    case "merged":
      return "done";
    case "amending":
      return "amending";
    case "blocked":
      return "blocked";
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

const PHASE_LABEL: Record<StepStatus, string> = {
  pending: "pending",
  building: "building",
  reviewing: "reviewing",
  done: "done",
};

export function phaseLabel(status: StepStatus): string {
  return PHASE_LABEL[status];
}
