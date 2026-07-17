"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLiveTurn } from "@/lib/api/job-stream";
import { threadLane } from "./phases";
import { overlayLiveTasks } from "./live-tasks";
import type {
  PipelineJob,
  PipelineThreadGroup,
  PipelineThread,
  PipelineReviewChild,
  ThreadGroupKind,
  TaskItem,
  JobStatus,
  ThreadStatus,
} from "@/lib/api/types";

/**
 * The Thread Navigator's THREADS region — design handoff "thread navigation": an ACCORDION. Selecting a
 * thread group reveals, in place, the things the thread group owns — its LLM-authored TASKS (server-folded
 * from the SDK TaskCreate/TaskUpdate calls), its ordered builder LEGS, and its read-only REVIEW AGENTS
 * (navigable child threads addressed by their own id) capped by the navigable "Post-review fixes" row — and
 * whichever thread group was open collapses (open = the selected lane, or the thread group whose review
 * agent is open). The whole-diff master review is now just another thread group in the list (rendered
 * "Master Review" with no review-agents fold), not a pinned region.
 */

// ── shared nav primitives (also used by the navigator skeleton) ──────────────────────────────────

/** A divider header (SPECS / ARTIFACTS / PORTS) — mono label, hairline rule, optional right count. */
export function Divider({
  label,
  count,
}: {
  label: string;
  count?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pb-1.5 pt-3">
      <span className="font-mono text-[9px] tracking-[0.16em] text-faint">
        {label}
      </span>
      <div className="h-px flex-1" style={{ background: "var(--border)" }} />
      {count != null ? (
        <span className="font-mono text-[9px] text-faint">{count}</span>
      ) : null}
    </div>
  );
}

// ── status helpers ───────────────────────────────────────────────────────────────────────────────

/** The design's thread states — a thread's `idle | done` status + its display-only `haltReason` fold onto
 *  one of these. `failed` is a thread whose last turn ended abnormally (a non-null `haltReason`). */
type LaneState = "draft" | "in_progress" | "done" | "failed";

function laneState(
  status: ThreadStatus,
  haltReason: string | null,
  drafted: boolean,
): LaneState {
  if (status === "done") return "done";
  if (haltReason) return "failed"; // the last turn ended abnormally (session_limit / error / …)
  if (drafted) return "draft"; // pre-approval / not yet reached — nothing has run
  return "in_progress"; // idle but reached: the currently-active thread
}

/** The open accordion's state-colored left rail + soft wash (handoff §State colors). */
function railStyle(
  state: LaneState,
  open: boolean,
): { borderLeftColor: string; background: string } {
  if (!open)
    return { borderLeftColor: "transparent", background: "transparent" };
  switch (state) {
    case "in_progress":
      return {
        borderLeftColor: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 4.5%, transparent)",
      };
    case "done":
      return {
        borderLeftColor: "var(--green)",
        background: "color-mix(in srgb, var(--green) 6%, transparent)",
      };
    case "failed":
      return {
        borderLeftColor: "var(--red)",
        background: "color-mix(in srgb, var(--red) 5%, transparent)",
      };
    default:
      return {
        borderLeftColor: "var(--border-2)",
        background: "color-mix(in srgb, var(--slate) 5%, transparent)",
      };
  }
}

// ── status glyphs (13px status dots · spinners · discs, straight from the handoff) ────────────────

/** A spinning progress ring — faint track + rotating colored arc (`.status-spin` = the design's 1.05s). */
function SpinRing({
  size = 13,
  color = "var(--accent)",
  track = "var(--border-2)",
  trackOpacity = 0.5,
}: {
  size?: number;
  color?: string;
  track?: string;
  trackOpacity?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="block"
      aria-hidden
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        fill="none"
        stroke={track}
        strokeWidth="2"
        opacity={trackOpacity}
      />
      <g className="status-spin">
        <circle
          cx="10"
          cy="10"
          r="7.5"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="14.14 47.12"
        />
      </g>
    </svg>
  );
}

/** The solid green disc with a white check — a `done` thread / `completed` task. */
function DoneDisc({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="block"
      aria-hidden
    >
      <circle cx="10" cy="10" r="8" fill="var(--green)" />
      <path
        d="M6.2 10.3l2.4 2.4 5-5.4"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The dashed pending/draft ring. */
function DashedRing({
  size = 13,
  color = "var(--border-2)",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="block"
      aria-hidden
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

/** The 13px status glyph slot on a thread header row. */
function ThreadStatusGlyph({ state }: { state: LaneState }) {
  return (
    <span className="grid h-[13px] w-[13px] shrink-0 place-items-center">
      {state === "failed" ? (
        <span
          className="h-[9px] w-[9px] rounded-full"
          style={{ background: "var(--red)" }}
        />
      ) : state === "done" ? (
        <DoneDisc />
      ) : state === "in_progress" ? (
        <SpinRing />
      ) : (
        <span
          className="h-[9px] w-[9px] rounded-full"
          style={{ border: "1.5px dashed var(--border-2)" }}
        />
      )}
    </span>
  );
}

// ── the accordion ──────────────────────────────────────────────────────────────────────────────────

export interface TreeProps {
  job: PipelineJob;
  status: JobStatus;
  /** The job id — each fold subscribes to its thread group's live lane to overlay mid-turn task calls. */
  jobId: string;
  /** The LEFT pane's open lane (`?lane=`) — the selected thread. A bare thread id opens the owning thread
   *  group's fold; a review-child id (review agents + the post-review fix are child threads too) opens its
   *  PARENT thread group's fold and highlights that child row. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}

/** The thread-group-kind → sidebar label for the singleton kinds. `section` is labeled "Section N §"
 *  separately (it carries a derived per-kind index); an unrecognized kind falls back to "Other". */
const THREAD_GROUP_LABELS: Partial<Record<ThreadGroupKind, string>> = {
  planning: "Planning",
  master_review: "Master review",
  post_build: "Post-build",
  ship: "Ship",
};

/**
 * A thread group's sidebar label. A `section` reads "Section N §" — the DERIVED per-kind index (its
 * position among same-kind groups), NOT the raw ordinal — with its slice name appended when set. Every
 * other kind derives a static label from its kind; an unknown kind buckets under "Other".
 */
function threadGroupLabel(group: PipelineThreadGroup, sectionIndex: number): string {
  if (group.kind === "section") {
    const name = group.title?.trim();
    return name ? `Section ${sectionIndex} § · ${name}` : `Section ${sectionIndex} §`;
  }
  return THREAD_GROUP_LABELS[group.kind] ?? group.title?.trim() ?? "Other";
}

/**
 * The THREADS accordion — one fold per THREAD GROUP, driven by its KIND. `planning` shows the planner
 * (chattable "Main") + the read-only Codex-review dialogue; a `section` shows its ordered builder LEGS +
 * read-only REVIEW AGENTS; `master_review`/`post_build`/`ship` are singleton folds; any unrecognized kind
 * buckets under "Other" so nothing silently disappears. Each fold owns its live TASKS (server-folded from
 * the SDK task tools).
 */
export function PipelineTree({
  job,
  status,
  jobId,
  laneNode,
  onSelectNode,
}: TreeProps) {
  // Pre-approval every build thread is a draft (dashed dot, no tasks — the plan shows only the threads).
  // Planning is always live, so its own fold never drafts (handled per-fold below).
  const drafted =
    status === "planning" ||
    status === "plan_review" ||
    status === "awaiting_approval";

  // DERIVED per-kind display index — the Nth `section` among the ordinal-sorted groups (never the raw
  // ordinal, which the backend spaces 10/20/30…).
  let sectionCount = 0;

  return (
    <>
      {job.threadGroups.map((group) => {
        const sectionIndex = group.kind === "section" ? ++sectionCount : 0;
        return (
          <ThreadGroupFold
            key={group.id}
            group={group}
            label={threadGroupLabel(group, sectionIndex)}
            jobId={jobId}
            drafted={drafted}
            laneNode={laneNode}
            onSelectNode={onSelectNode}
          />
        );
      })}
    </>
  );
}

/**
 * One accordion fold — the clickable thread-group header (status glyph · label · count chip) over the open
 * body (TASKS → LEGS / Codex-review → REVIEW children, or the draft empty state). A fold is OPEN when the
 * routed thread is one of its threads (a builder leg / planner / codex_review / singleton) or one of its
 * review CHILD threads. The header routes to the group's primary thread: the planner for `planning`, the
 * latest leg for a `section`, else the group's single thread.
 */
function ThreadGroupFold({
  group,
  label,
  jobId,
  drafted,
  laneNode,
  onSelectNode,
}: {
  group: PipelineThreadGroup;
  label: string;
  jobId: string;
  drafted: boolean;
  /** The routed thread id (`/workspace/:jobKey/:threadId`) — a bare thread/child id, or null transiently. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const roots = group.threads;
  const isPlanning = group.kind === "planning";
  const isSection = group.kind === "section";
  const legs = isSection ? roots.filter((t) => t.role === "builder") : [];
  const codexReview = isPlanning
    ? (roots.find((t) => t.role === "codex_review") ?? null)
    : null;
  // The header routes to the group's PRIMARY thread: the planner for planning (the "Main" chat), the latest
  // leg for a section, else the group's single thread. It also drives the header glyph + live task overlay.
  const primary = isPlanning
    ? (roots.find((t) => t.role === "planner") ?? roots[0])
    : roots[roots.length - 1];

  // REALTIME: fold the primary thread's live lane over the durable list, so mid-turn task calls tick instantly
  // (the pipeline query only refetches at turn end). Idle lanes read a dead key — cheap store lookup. Hook must
  // run unconditionally (Rules of Hooks), so the empty-group guard comes after it.
  const liveTurn = useLiveTurn(jobId, threadLane(primary?.id ?? ""));
  if (!primary) return null;

  // Planning is always live, so it never drafts even pre-approval.
  const state = laneState(primary.status, primary.haltReason, drafted && !isPlanning);

  const reviewChildren = roots.flatMap((t) => t.children ?? []);
  const reviewLenses = reviewChildren.filter((c) => c.role === "review_agent");
  const postReview = reviewChildren.find((c) => c.role === "review_fix") ?? null;

  const open =
    laneNode != null &&
    (roots.some((t) => t.id === laneNode) ||
      reviewChildren.some((c) => c.id === laneNode));

  const tasks = overlayLiveTasks(group.tasks, liveTurn);
  const done = tasks.filter((t) => t.status === "completed").length;
  const isDraft = state === "draft";
  const count = isDraft
    ? "draft"
    : tasks.length > 0
      ? `${done}/${tasks.length}`
      : "";

  return (
    <div className="border-l-[3px]" style={railStyle(state, open)}>
      <button
        type="button"
        onClick={() => onSelectNode(primary.id)}
        className="flex w-full items-center gap-2 py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-2"
      >
        <ThreadStatusGlyph state={state} />
        <span
          className={cn(
            "flex-1 truncate text-[12px]",
            open ? "font-semibold text-text" : "font-medium text-dim",
          )}
        >
          {label}
        </span>
        {count ? (
          <span className="shrink-0 text-right font-mono text-[8px] text-faint">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        isDraft ? (
          <DraftEmptyBody />
        ) : (
          <>
            <TasksBody tasks={tasks} done={done} total={tasks.length} />
            {codexReview ? (
              <div className="nav-expand mb-2 ml-[9px] flex flex-col gap-[2px]">
                <BodyHeader label="PLAN REVIEW" right="" />
                <LegRow
                  label="Codex review"
                  state={laneState(codexReview.status, codexReview.haltReason, false)}
                  selected={laneNode === codexReview.id}
                  onOpen={() => onSelectNode(codexReview.id)}
                />
              </div>
            ) : null}
            {legs.length > 1 ? (
              <LegsBody
                threads={legs}
                drafted={drafted}
                laneNode={laneNode}
                onSelectNode={onSelectNode}
              />
            ) : null}
            {reviewLenses.length > 0 ? (
              <ReviewAgentsBody
                lenses={reviewLenses}
                postReview={postReview}
                laneNode={laneNode}
                onSelectNode={onSelectNode}
              />
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

/** The mono "TASKS · done/total" sub-header shared by every fold body. */
function BodyHeader({ label, right }: { label: string; right: string }) {
  return (
    <div className="flex items-center gap-2 px-1.5 pb-1 pt-px">
      <span className="font-mono text-[8px] tracking-[0.12em] text-faint">
        {label}
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[8px] text-border-2">{right}</span>
    </div>
  );
}

/** A draft thread's open body — no tasks yet, Atlas is still drafting it (handoff §Draft empty state). */
function DraftEmptyBody() {
  return (
    <div className="nav-expand mb-1.5 ml-[9px] flex flex-col">
      <BodyHeader label="TASKS" right="—" />
      <p className="px-1.5 pb-1.5 text-[11px] italic leading-relaxed text-faint">
        Atlas is drafting this thread — no tasks yet.
      </p>
    </div>
  );
}

/** Numeric-aware id order — the fold's insertion order scrambles when updates arrive for ids the fold
 *  hasn't seen (defensive entries append), so the display always sorts by id (SDK ids are monotonic). */
function byTaskId(a: TaskItem, b: TaskItem): number {
  const na = Number(a.id);
  const nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.id.localeCompare(b.id);
}

/** The most-recent completed tasks stay visible so a task doesn't vanish the instant it's checked off —
 *  it lingers here as newer tasks finish, then rolls into the fold. */
const DONE_TAIL = 2;
/** Only fold once at least this many completed tasks would actually be hidden (below it, folding a row or
 *  two behind a disclosure isn't worth the click — the list just renders in full, pure id order). */
const DONE_FOLD_MIN = 2;

/** The open thread group's TASKS section — the thread group's live, LLM-authored checklist. Exported for
 *  the navigator's Main row, whose fold shows the brain session's own list (`pipelineMainTasks`) the same
 *  way. */
export function TasksBody({
  tasks,
  done,
  total,
}: {
  tasks: TaskItem[];
  done: number;
  total: number;
}) {
  const ordered = [...tasks].sort(byTaskId);
  // BLOCKED is derived, not stored: a pending task whose `blockedBy` edge points at a still-incomplete
  // sibling. Completing (or deleting — it's gone from the list) a blocker clears the block by itself.
  const byId = new Map(ordered.map((t) => [t.id, t]));
  const openBlockers = (t: TaskItem): string[] =>
    t.status === "pending"
      ? (t.blockedBy ?? []).filter((id) => {
          const b = byId.get(id);
          return b != null && b.status !== "completed";
        })
      : [];

  // A long finished run folds away, but the last DONE_TAIL completed tasks stay pinned (a just-finished
  // task lingers there as newer ones complete, then rolls into the fold) and everything still in flight
  // (pending/in_progress/blocked/dropped) is always visible. Only the OLDER completed tasks hide, and
  // only once enough of them pile up to earn the disclosure — otherwise the pure id-ordered list renders.
  const [showDone, setShowDone] = useState(false);
  const completed = ordered.filter((t) => t.status === "completed");
  const active = ordered.filter((t) => t.status !== "completed");
  const hidden = completed.slice(0, Math.max(0, completed.length - DONE_TAIL));
  const tail = completed.slice(hidden.length);
  const fold = hidden.length >= DONE_FOLD_MIN;

  return (
    <div className="nav-expand mb-1.5 ml-[9px] flex flex-col gap-px">
      <BodyHeader label="TASKS" right={total > 0 ? `${done}/${total}` : "—"} />
      {ordered.length === 0 ? (
        <p className="px-1.5 pb-1.5 text-[11px] italic leading-relaxed text-faint">
          No tasks yet — Atlas creates them once this thread starts.
        </p>
      ) : fold ? (
        <>
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-[4px] py-1 pl-1.5 pr-1 text-left text-[11px] text-faint transition hover:text-dim"
            aria-expanded={showDone}
          >
            <span className="mt-px h-[13px] w-[13px] shrink-0">
              <DoneDisc />
            </span>
            <span className="min-w-0 flex-1">{hidden.length} more done</span>
            <ChevronRight
              size={9}
              strokeWidth={3}
              className={cn(
                "mt-px flex-none transition-transform",
                showDone && "rotate-90",
              )}
            />
          </button>
          {showDone ? hidden.map((t) => <TaskRow key={t.id} task={t} />) : null}
          {tail.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
          {active.map((t) => (
            <TaskRow key={t.id} task={t} blockers={openBlockers(t)} />
          ))}
        </>
      ) : (
        ordered.map((t) => (
          <TaskRow key={t.id} task={t} blockers={openBlockers(t)} />
        ))
      )}
    </div>
  );
}

/**
 * One task row — 13px status glyph · subject (+ meta line and description while in_progress or blocked —
 * a density decision: completed/pending stay single-line, full description in the tooltip) · `#id` chip.
 * BLOCKED (a pending task with open `blockers`) gets the slate ring-and-dot glyph + a "blocked by #N"
 * note. A legacy `dropped` row stays struck through.
 */
function TaskRow({
  task: t,
  blockers = [],
}: {
  task: TaskItem;
  blockers?: string[];
}) {
  const struck = t.status === "completed" || t.status === "dropped";
  const inProgress = t.status === "in_progress";
  const blocked = blockers.length > 0;
  const expanded = inProgress || blocked; // the rows that earn a second line
  return (
    <div
      className="flex items-start gap-1.5 py-1 pl-1.5 pr-1"
      title={t.description || t.subject}
    >
      <span className="mt-px h-[13px] w-[13px] shrink-0">
        {t.status === "completed" ? (
          <DoneDisc />
        ) : inProgress ? (
          <SpinRing />
        ) : blocked ? (
          <BlockedRing />
        ) : t.status === "dropped" ? (
          <DashedRing color="var(--faint)" />
        ) : (
          <DashedRing />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[11.5px] leading-[1.35]",
            inProgress
              ? "text-text"
              : struck
                ? "text-faint line-through"
                : "text-dim",
          )}
        >
          {t.subject}
        </span>
        {inProgress ? (
          <span className="mt-px block font-mono text-[8px] tracking-[0.02em] text-accent">
            {(t.activeForm || t.subject) + "…"}
          </span>
        ) : blocked ? (
          <span
            className="mt-px block font-mono text-[8px] tracking-[0.02em]"
            style={{ color: "var(--slate)" }}
          >
            blocked by {blockers.map((b) => `#${b}`).join(" · ")}
          </span>
        ) : null}
        {expanded && t.description ? (
          <span className="mt-0.5 block text-[10px] leading-[1.4] text-faint">
            {t.description}
          </span>
        ) : null}
      </span>
      <span className="mt-px shrink-0 font-mono text-[8px] text-faint">
        #{t.id}
      </span>
    </div>
  );
}

/** The blocked glyph — slate ring with a center dot (handoff §Task row). */
function BlockedRing({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="block"
      aria-hidden
    >
      <circle
        cx="10"
        cy="10"
        r="7.5"
        fill="none"
        stroke="var(--slate)"
        strokeWidth="2"
      />
      <circle cx="10" cy="10" r="2.7" fill="var(--slate)" />
    </svg>
  );
}

// ── REVIEW children — each review lens + the post-review fix are first-class child threads ─────────

/** The design's agent states — a review child's `idle | done` status + `haltReason` fold onto these. */
type AgentDisplay = "in_progress" | "done" | "failed";

/** Map a review CHILD thread's status + halt reason to its navigator display state. */
function childDisplay(status: ThreadStatus, haltReason: string | null): AgentDisplay {
  if (haltReason) return "failed"; // the lens's last turn ended abnormally (engine/auth error) — surface it
  if (status === "done") return "done"; // terminal — the lens ran clean
  return "in_progress"; // idle: running or awaiting its turn
}

function ReviewAgentsBody({
  lenses,
  postReview,
  laneNode,
  onSelectNode,
}: {
  lenses: PipelineReviewChild[];
  postReview: PipelineReviewChild | null;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  return (
    <div className="nav-expand mb-2 ml-[9px] flex flex-col gap-[2px]">
      <BodyHeader label="REVIEW AGENTS" right={String(lenses.length)} />
      {lenses.map((c) => (
        <AgentRow
          key={c.id}
          child={c}
          selected={laneNode === c.id}
          onOpen={() => onSelectNode(c.id)}
        />
      ))}
      {postReview ? (
        <PostReviewFixesRow
          state={postReviewState(postReview.status, postReview.haltReason)}
          selected={laneNode === postReview.id}
          onOpen={() => onSelectNode(postReview.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * The LEGS body (context-rot rotation) — one NAVIGABLE row per sequential builder thread ("Leg") in a build
 * thread group. Each rotated builder is a first-class thread: clicking a Leg opens that thread's own
 * transcript. Rendered only once a build thread group has rotated ≥1× (2+ builder legs); a single-leg thread
 * group shows nothing here (its one thread is addressed by the thread group header itself).
 */
function LegsBody({
  threads,
  drafted,
  laneNode,
  onSelectNode,
}: {
  threads: PipelineThread[];
  drafted: boolean;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  return (
    <div className="nav-expand mb-2 ml-[9px] flex flex-col gap-[2px]">
      <BodyHeader label="LEGS" right={String(threads.length)} />
      {threads.map((leg, i) => (
        <LegRow
          key={leg.id}
          label={`Leg ${i + 1}`}
          state={laneState(leg.status, leg.haltReason, drafted)}
          selected={laneNode === leg.id}
          onOpen={() => onSelectNode(leg.id)}
        />
      ))}
    </div>
  );
}

/** One navigable single-line row (session dot · label · status word) — a builder Leg or the read-only
 *  Codex-review thread. Opens that thread's own transcript in the LEFT pane. */
function LegRow({
  label,
  state,
  selected,
  onOpen,
}: {
  label: string;
  state: LaneState;
  selected: boolean;
  onOpen: () => void;
}) {
  const word =
    state === "in_progress"
      ? "live"
      : state === "done"
        ? "done"
        : state === "failed"
          ? "failed"
          : "draft";
  const wordColor =
    state === "in_progress"
      ? "var(--blue)"
      : state === "done"
        ? "var(--green)"
        : state === "failed"
          ? "var(--red)"
          : "var(--faint)";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 px-1.5 py-[3px] text-left transition hover:bg-surface-2",
        selected && "bg-surface-2",
      )}
    >
      <span
        className="ml-[3px] size-[6px] shrink-0 rounded-full"
        style={{ background: wordColor }}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11.5px]",
          selected ? "font-semibold text-text" : "font-medium text-dim",
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-[10px] font-medium" style={{ color: wordColor }}>
        {word}
      </span>
    </button>
  );
}

/** The post-review fix child's status + halt reason → its row's display states. */
function postReviewState(
  status: ThreadStatus,
  haltReason: string | null,
): "running" | "done" | "failed" {
  if (haltReason) return "failed"; // the fix turn ended abnormally — don't paint it done
  if (status === "done") return "done";
  return "running"; // idle: applying fixes / awaiting its turn
}

/** One review lens — a single-line navigable child thread: status tile · name · status word · chevron.
 *  Clicking opens the lens's own transcript in the LEFT pane (its `autofix:…:<lensId>` lane); the parent
 *  fold stays open. Its id is the child THREAD's real id (no synthetic `rev:` prefix). */
function AgentRow({
  child: c,
  selected,
  onOpen,
}: {
  child: PipelineReviewChild;
  selected: boolean;
  onOpen: () => void;
}) {
  const d = childDisplay(c.status, c.haltReason);
  const word = d === "failed" ? "failed" : d === "done" ? "done" : "reviewing";
  const wordColor =
    d === "failed"
      ? "var(--red)"
      : d === "done"
        ? "var(--green)"
        : "var(--blue)";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 px-1.5 py-[3px] text-left transition",
        selected
          ? "bg-panel shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          : "hover:bg-surface-2",
      )}
    >
      <AgentStatusTile display={d} />
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-text">
        {c.brief}
      </span>
      <span
        className="shrink-0 font-mono text-[8px]"
        style={{ color: wordColor }}
      >
        {word}
      </span>
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke={selected ? "var(--accent)" : "var(--border-2)"}
        strokeWidth="3"
        className="shrink-0"
        aria-hidden
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

/** The 16px status icon tile on an agent-style row (blue spinner / green check / dashed pending). */
function AgentStatusTile({
  display,
}: {
  display: AgentDisplay | "running";
}) {
  const done = display === "done";
  const failed = display === "failed";
  const spinning = display === "in_progress" || display === "running";
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded"
      style={{
        color: done
          ? "var(--green)"
          : failed
            ? "var(--red)"
            : spinning
              ? "var(--blue)"
              : "var(--faint)",
        background: done
          ? "var(--green-soft)"
          : failed
            ? "var(--red-soft)"
            : spinning
              ? "var(--blue-soft)"
              : "var(--surface-3)",
      }}
    >
      {done ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : failed ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      ) : spinning ? (
        <SpinRing
          size={11}
          color="currentColor"
          track="currentColor"
          trackOpacity={0.28}
        />
      ) : (
        <svg
          width="11"
          height="11"
          viewBox="0 0 20 20"
          className="block"
          aria-hidden
        >
          <circle
            cx="10"
            cy="10"
            r="7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeDasharray="3 3"
          />
        </svg>
      )}
    </span>
  );
}

/** The consolidation agent's row — runs after the review agents finish; applies fixes and verifies.
 *  Navigable: opens the fix turn's transcript (`fix:<threadId>` → `autofix:<threadId>:fix` lane) in the
 *  LEFT pane, like a review agent. Separated by a dashed rule per the design. */
function PostReviewFixesRow({
  state,
  selected,
  onOpen,
}: {
  state: "running" | "done" | "failed";
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Runs after the review agents finish — applies fixes and verifies. Open its transcript."
      className={cn(
        "mt-[2px] flex w-full items-center gap-2 border-t border-dashed px-1.5 pb-[3px] pt-1.5 text-left transition",
        selected
          ? "bg-panel shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          : "hover:bg-surface-2",
      )}
      style={{ borderColor: "var(--border-2)" }}
    >
      <AgentStatusTile display={state} />
      <span
        className={cn(
          "min-w-0 flex-1 text-[11.5px] font-semibold",
          state === "done" ? "text-text" : "text-dim",
        )}
      >
        Post-review fixes
      </span>
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke={selected ? "var(--accent)" : "var(--border-2)"}
        strokeWidth="3"
        className="shrink-0"
        aria-hidden
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
