import {
  CheckCircle2,
  CircleSlash2,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  LoaderCircle,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { KIND_META, STATUS_META } from "@/lib/api/status";
import type { CiStatus, InboxPr, JobKind, JobStatus } from "@/lib/api/types";

/** A status dot — colored by status, optionally pulsing (running/triaging) with a soft glow. */
export function StatusDot({
  status,
  size = 8,
  className,
}: {
  status: JobStatus;
  size?: number;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full",
        meta.pulse && "pulse-dot",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: meta.color,
        boxShadow: meta.pulse
          ? `0 0 0 3px color-mix(in srgb, ${meta.color} 18%, transparent)`
          : undefined,
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
      className={cn(
        "inline-block shrink-0 rounded-full",
        pulse && "pulse-dot",
        className,
      )}
      style={{ width: size, height: size, background: color }}
      aria-hidden
    />
  );
}

/** FEAT / FIX / EVENT mono badge — NEUTRAL grey + hairline border (handoff: no per-kind color). */
export function KindBadge({
  kind,
  className,
}: {
  kind: JobKind;
  className?: string;
}) {
  const meta = KIND_META[kind];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] border border-border-2 px-[5px] py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.06em] text-dim",
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

/**
 * Status "pie" — a 14px glyph whose SHAPE encodes the thread's stage and whose COLOR (from
 * {@link STATUS_META}) names the specific status. Every status is visually distinct:
 *   forming  (planning / triaging)  → dashed ring          · triaging breathes
 *   reviewing(plan_review)          → faint dashed base + a solid arc scanning around it
 *   working  (running)              → spinning arc          · the autonomous "build is churning" spinner
 *   waiting  (awaiting_approval)    → ring + center dot      · bullseye = your move
 *   paused                          → ring + pause bars
 *   failed                          → ring + ✕
 *   done                            → filled disc + ✓
 *
 * `plan_review` stays in the cool, pre-approval family (blue, like Planning) — it's the
 * you're-in-the-loop phase (Codex reviewing a plan you haven't approved yet), NOT the autonomous
 * post-approval build. Its scanning arc reads as "reviewing" without borrowing `running`'s orange
 * spinner. `status` undefined → a neutral hollow ring (the cross-org inbox carries no status for
 * most rows yet — see `inbox.ts`).
 */
const STATUS_SHAPE: Record<
  JobStatus,
  "forming" | "reviewing" | "working" | "waiting" | "paused" | "failed" | "done"
> = {
  planning: "forming",
  triaging: "forming",
  plan_review: "reviewing",
  running: "working",
  awaiting_approval: "waiting",
  // The ship-review gate — the second "your move" bullseye, same shape as the plan-approval gate.
  awaiting_ship_review: "waiting",
  done: "done",
  // A genuine operator-chosen terminal state (plan denied) — same muted static ring as deleting.
  cancelled: "paused",
  // Winding down — a muted static ring; the faint color (STATUS_META) carries the "Deleting…" meaning.
  deleting: "paused",
};

export function StatusPie({
  status,
  halted = false,
  size = 14,
}: {
  status?: JobStatus;
  /** A turn-stopping error is outstanding — force the `failed` ✕ glyph (danger color) regardless of
   *  `status`, so a stopped thread reads like the EXDEV failed job even while its pipeline stage lives on. */
  halted?: boolean;
  size?: number;
}) {
  const shape = halted ? "failed" : status ? STATUS_SHAPE[status] : null;
  const color = halted
    ? "var(--red)"
    : status
      ? STATUS_META[status].color
      : "var(--border-2)";
  const r = 7.5;
  const circ = 2 * Math.PI * r;
  const ring = (
    stroke: string,
    extra?: Omit<React.SVGProps<SVGCircleElement>, "ref">,
  ) => (
    <circle
      cx={10}
      cy={10}
      r={r}
      fill="none"
      stroke={stroke}
      strokeWidth={2}
      {...extra}
    />
  );

  let kids: React.ReactNode;
  if (shape === "forming") {
    // Dashed ring — pre-approval "forming". Planning is static, waiting on you to talk; triaging
    // breathes (the model is actively triaging an untrusted event).
    kids = ring(color, {
      strokeDasharray: "2 2.8",
      strokeLinecap: "round",
      className: status === "triaging" ? "status-breathe" : undefined,
    });
  } else if (shape === "reviewing") {
    // Faint dashed base (still "forming") + a solid arc scanning around it — Codex reviewing the plan.
    kids = (
      <>
        {ring(color, {
          strokeDasharray: "2 2.8",
          strokeLinecap: "round",
          opacity: 0.4,
        })}
        <g className="status-spin">
          <circle
            cx={10}
            cy={10}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${circ * 0.19} ${circ}`}
          />
        </g>
      </>
    );
  } else if (shape === "working") {
    // Faint thread + a rotating accent arc — a true spinner for "AI is working".
    kids = (
      <>
        {ring("var(--border-2)", { opacity: 0.5 })}
        <g className="status-spin">
          <circle
            cx={10}
            cy={10}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${circ * 0.3} ${circ}`}
          />
        </g>
      </>
    );
  } else if (shape === "waiting") {
    // Bullseye — solid ring with a filled center: parked, waiting on you.
    kids = (
      <>
        {ring(color)}
        <circle cx={10} cy={10} r={2.7} fill={color} />
      </>
    );
  } else if (shape === "paused") {
    kids = (
      <>
        {ring(color)}
        <rect x={8.1} y={7} width={1.4} height={6} rx={0.6} fill={color} />
        <rect x={10.5} y={7} width={1.4} height={6} rx={0.6} fill={color} />
      </>
    );
  } else if (shape === "failed") {
    kids = (
      <>
        {ring(color)}
        <path
          d="M7.6 7.6 L12.4 12.4 M12.4 7.6 L7.6 12.4"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      </>
    );
  } else if (shape === "done") {
    // Filled disc + a checkmark knocked out in the panel color.
    kids = (
      <>
        <circle cx={10} cy={10} r={r + 1} fill={color} />
        <path
          d="M6.7 10.3 L9 12.5 L13.3 7.7"
          fill="none"
          stroke="var(--panel)"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    );
  } else {
    kids = ring("var(--border-2)");
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="block shrink-0"
      aria-hidden
    >
      {kids}
    </svg>
  );
}

/**
 * PR-status glyph — shown on a job leaf INSTEAD of the build {@link StatusPie} once the job has a PR
 * ({@link InboxThread.pr} is non-null). Follows GitHub's color convention so the sidebar reads at a glance:
 *   open & ready → green  pull-request
 *   merge conflict (`mergeable === 'dirty'`) → amber pull-request
 *   merged → purple git-merge     · closed (unmerged) → red pull-request-closed
 * The job row itself never disappears on merge (the sandbox is torn down but the job stays "truly done").
 */
export function PrStatusIcon({
  pr,
  size = 14,
}: {
  pr: InboxPr;
  size?: number;
}) {
  const { Icon, color, title } = prGlyph(pr);
  return (
    <Icon
      size={size}
      strokeWidth={2}
      style={{ color }}
      className="block shrink-0"
      aria-label={title}
    >
      <title>{title}</title>
    </Icon>
  );
}

function prGlyph(pr: InboxPr): {
  Icon: typeof GitPullRequest;
  color: string;
  title: string;
} {
  if (pr.state === "merged")
    return { Icon: GitMerge, color: "var(--purple)", title: "PR merged" };
  if (pr.state === "closed")
    return {
      Icon: GitPullRequestClosed,
      color: "var(--red)",
      title: "PR closed",
    };
  // open — conflict refines the ready state.
  if (pr.mergeable === "dirty") {
    return {
      Icon: GitPullRequest,
      color: "var(--amber)",
      title: "PR has a merge conflict",
    };
  }
  return { Icon: GitPullRequest, color: "var(--green)", title: "PR open" };
}

/**
 * Four-state CI glyph for a PR head (backend `jobs.ci_status`) — shared by the job header and the sidebar
 * dot so the two never disagree.
 *   success → green check-circle "CI passed"
 *   failure → red x-circle "CI failed"
 *   pending → amber loader (pulsing) "CI running"
 *   null    → neutral slashed-circle "No CI"
 */
export function ciGlyph(ci: CiStatus | null): {
  Icon: typeof CheckCircle2;
  color: string;
  title: string;
  pulse: boolean;
} {
  if (ci === "success")
    return {
      Icon: CheckCircle2,
      color: "var(--green)",
      title: "CI passed",
      pulse: false,
    };
  if (ci === "failure")
    return {
      Icon: XCircle,
      color: "var(--red)",
      title: "CI failed",
      pulse: false,
    };
  if (ci === "pending")
    return {
      Icon: LoaderCircle,
      color: "var(--amber)",
      title: "CI running",
      pulse: true,
    };
  return {
    Icon: CircleSlash2,
    color: "var(--faint)",
    title: "No CI",
    pulse: false,
  };
}

/** The CI glyph shown in the job header after the `PR #NN · open` line — a `·` separator + the four-state
 *  {@link ciGlyph} icon (pulsing while running). Shared by both PR header branches (linked `<a>` and
 *  inline `<div>`) so the two can't drift. */
export function CiHeaderGlyph({ ci }: { ci: CiStatus | null }) {
  const g = ciGlyph(ci);
  const { Icon, color, title, pulse } = g;
  return (
    <span className="flex shrink-0 items-center gap-0.5" title={title}>
      <span className="font-mono text-[9.5px] text-faint">·</span>
      <Icon
        size={11}
        strokeWidth={2}
        style={{ color }}
        className={cn("shrink-0", pulse && "pulse-dot")}
        aria-label={title}
      />
    </span>
  );
}

/** A subtle CI dot for the sidebar job row — a small colored corner dot mirroring the halt dot. Keep it
 *  ≤7px so it reads at a glance without crowding the PR glyph. */
export function CiStatusDot({
  ci,
  size = 7,
}: {
  ci: CiStatus | null;
  size?: number;
}) {
  const g = ciGlyph(ci);
  return (
    <span
      className={cn(
        "absolute -bottom-px -left-0.5 rounded-full border-[1.5px] border-panel",
        g.pulse && "pulse-dot",
      )}
      style={{ width: size, height: size, background: g.color }}
      title={g.title}
      aria-label={g.title}
    />
  );
}

/** Status pill: a dot + label, tinted by status. */
export function StatusPill({
  status,
  className,
}: {
  status: JobStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
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
