"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLiveTurn } from "@/lib/api/job-stream";
import { threadLane } from "./phases";
import { overlayLiveTasks } from "./live-tasks";
import type {
  PipelineJob,
  PipelineStage,
  PipelineThread,
  PipelineReviewChild,
  StageKind,
  TaskItem,
  JobStatus,
  ThreadStatus,
  ThreadCondition,
} from "@/lib/api/types";

/**
 * The Thread Navigator's THREADS region — design handoff "thread navigation": an ACCORDION. Selecting a
 * stage reveals, in place, the things the stage owns — its LLM-authored TASKS (server-folded from the
 * SDK TaskCreate/TaskUpdate calls), its ordered builder LEGS, and its read-only REVIEW AGENTS (navigable
 * child threads addressed by their own id) capped by the navigable "Post-review fixes" row — and whichever
 * stage was open collapses (open = the selected lane, or the stage whose review agent is open). The
 * whole-diff master review is now just another stage in the list (rendered "Master Review" with no
 * review-agents fold), not a pinned region.
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

/** The halt thread for a failed job: the furthest in-flight (non-done, non-pending) thread, else the
 *  last non-done one. Exported so the navigator's halt banner derives the same index. */
export function haltThreadIdx(
  threads: { status: ThreadStatus; condition: ThreadCondition }[],
): number {
  // A halted/paused/failed lane carries a non-none condition — that's the row that owns the job halt.
  for (let i = threads.length - 1; i >= 0; i -= 1) {
    if (threads[i].condition !== "none") return i;
  }
  // Fallbacks (no lane flagged a condition): the furthest in-flight, else the last non-done step.
  for (let i = threads.length - 1; i >= 0; i -= 1) {
    const st = threads[i].status;
    if (st !== "done" && st !== "pending") return i;
  }
  for (let i = threads.length - 1; i >= 0; i -= 1) {
    if (threads[i].status !== "done") return i;
  }
  return -1;
}

/** The design's thread states — every wire `ThreadStatus` folds onto one of these. `blocked` is a RESTING
 *  state (the thread halted awaiting the operator), visually distinct from `in_progress` (actively running)
 *  so a thread parked on `block_thread`/a question doesn't masquerade as a live turn. */
type LaneState = "draft" | "in_progress" | "blocked" | "done" | "failed";

function laneState(
  s: ThreadStatus,
  condition: ThreadCondition,
  drafted: boolean,
): LaneState {
  if (drafted || s === "pending") return "draft";
  if (condition === "failed" || condition === "incomplete") return "failed"; // terminal halts (nothing shipped)
  if (condition === "paused") return "blocked"; // halted, waiting on the operator — NOT a running turn
  if (s === "done") return "done";
  return "in_progress"; // planning / reviewing / executing / auto_fixing
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
    case "blocked":
      return {
        borderLeftColor: "var(--slate)",
        background: "color-mix(in srgb, var(--slate) 6%, transparent)",
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
function ThreadStatusGlyph({
  state,
  isHalt,
}: {
  state: LaneState;
  isHalt: boolean;
}) {
  // The lane's OWN state owns its glyph: a `blocked` (paused) or `done` lane keeps its glyph even when it
  // is the job's halt row, so it never masquerades as a red failure. `isHalt` only paints red as a fallback
  // for a halt whose lane state doesn't already show it (e.g. a job-level halt on an in-flight lane).
  const haltRed =
    state === "failed" || (isHalt && state !== "blocked" && state !== "done");
  return (
    <span className="grid h-[13px] w-[13px] shrink-0 place-items-center">
      {haltRed ? (
        <span
          className="h-[9px] w-[9px] rounded-full"
          style={{ background: "var(--red)" }}
        />
      ) : state === "done" ? (
        <DoneDisc />
      ) : state === "blocked" ? (
        <BlockedRing />
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
  /** The job id — each fold subscribes to its stage's live lane to overlay mid-turn task calls. */
  jobId: string;
  /** The LEFT pane's open lane (`?lane=`) — the selected thread. A bare thread id opens the owning stage's
   *  fold; a review-child id (review agents + the post-review fix are child threads too) opens its PARENT
   *  stage's fold and highlights that child row. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}

/** The stage-kind → sidebar label, used when a stage carries no explicit `title`. */
const STAGE_LABELS: Record<StageKind, string> = {
  planning: "Planning",
  plan_review: "Plan Review",
  build: "Build",
  direct_build: "Direct Build",
  master_review: "Master Review",
  post_build: "Post Build",
  ci: "CI",
};

/** A stage's sidebar label — its explicit `title` (a build slice name, or a "Re-plan #N" round) when set,
 *  else derived from its kind. */
function stageLabel(stage: PipelineStage): string {
  return stage.title?.trim() || STAGE_LABELS[stage.kind];
}

/**
 * The THREADS build lanes — one accordion fold per STAGE. Each stage owns its live TASKS (server-folded from
 * the SDK task tools) and, for a build stage, its ordered builder LEGS + read-only REVIEW AGENTS (the
 * builders' review-child threads) capped by the derived Post-review fixes row. Draft stages (pre-approval or
 * not yet reached) fold to the drafting empty state. The Main (planning) row and the plan-review row are
 * pinned above the tree by the navigator, so they are skipped here.
 */
export function PipelineTree({
  job,
  status,
  jobId,
  laneNode,
  onSelectNode,
}: TreeProps) {
  const stages = job.stages.filter(
    (s) => s.kind !== "planning" && s.kind !== "plan_review",
  );
  // Pre-approval every thread is a draft (dashed dot, no tasks — the plan shows only the threads).
  const drafted =
    status === "planning" ||
    status === "plan_review" ||
    status === "awaiting_approval";
  // Halted: threads aren't persisted with the halt (only the job carries it), so derive the halt point over
  // the whole flattened thread list — the in-flight thread (furthest non-`done`/non-`pending`) is where the
  // run stopped; later ones never ran. Identify it by id so it maps across the stage grouping.
  const allThreads = job.stages.flatMap((s) => s.threads);
  const haltIdx = job.halt != null ? haltThreadIdx(allThreads) : -1;
  const haltThreadId = haltIdx >= 0 ? (allThreads[haltIdx]?.id ?? null) : null;
  const notReached = new Set(
    haltIdx >= 0 ? allThreads.slice(haltIdx + 1).map((t) => t.id) : [],
  );

  return (
    <>
      {stages.map((stage) => (
        <StageFold
          key={stage.id}
          stage={stage}
          jobId={jobId}
          drafted={drafted}
          haltThreadId={haltThreadId}
          notReached={notReached}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />
      ))}
    </>
  );
}

/**
 * One accordion fold — the clickable stage header (status glyph · label · count chip) over the open body
 * (TASKS → LEGS → REVIEW children → Post-review fixes, or the draft empty state). A stage is OPEN when one
 * of its threads (a builder leg / master review / the singleton thread) OR one of its review CHILD threads
 * is the open lane — they all ride the same LEFT pane as bare thread nodes. Clicking the header opens the
 * stage's latest thread; navigate back to Main by clicking the Main row itself.
 */
function StageFold({
  stage,
  jobId,
  drafted,
  haltThreadId,
  notReached,
  laneNode,
  onSelectNode,
}: {
  stage: PipelineStage;
  jobId: string;
  drafted: boolean;
  /** The id of the thread that owns the job halt, or null when the job is healthy. */
  haltThreadId: string | null;
  /** Thread ids the run never reached (after the halt point) — rendered muted. */
  notReached: Set<string>;
  /** The open LEFT-pane lane node (`?lane=`) — a bare thread/child id, or null for Main. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const roots = stage.threads;
  // The latest thread drives the header glyph + live task overlay (a build stage's newest builder leg; a
  // singleton stage's one thread). A stage should never be empty, but guard so a malformed one renders nothing.
  const primary = roots[roots.length - 1];
  if (!primary) return null;

  const state = laneState(primary.status, primary.condition, drafted);
  const isHalt = roots.some((t) => t.id === haltThreadId);
  const stageNotReached = roots.every((t) => notReached.has(t.id));

  const reviewChildren = roots.flatMap((t) => t.children ?? []);
  const reviewLenses = reviewChildren.filter((c) => c.role === "review_agent");
  const postReview = reviewChildren.find((c) => c.role === "review_fix") ?? null;

  const open =
    laneNode != null &&
    (roots.some((t) => t.id === laneNode) ||
      reviewChildren.some((c) => c.id === laneNode));

  // REALTIME: fold the latest thread's live lane over the durable list, so mid-turn task calls tick instantly
  // (the pipeline query only refetches at turn end). Idle lanes read a dead key — cheap store lookup.
  const liveTurn = useLiveTurn(jobId, threadLane(primary.id));
  const tasks = overlayLiveTasks(stage.tasks, liveTurn);
  const done = tasks.filter((t) => t.status === "completed").length;
  const isDraft = state === "draft";
  const count = isDraft
    ? "draft"
    : tasks.length > 0
      ? `[${done}/${tasks.length}]`
      : "";

  return (
    <div className="border-l-[3px]" style={railStyle(state, open)}>
      <button
        type="button"
        onClick={() => onSelectNode(primary.id)}
        className={cn(
          "flex w-full items-center gap-2 py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-2",
          stageNotReached && "opacity-60",
        )}
      >
        <ThreadStatusGlyph state={state} isHalt={isHalt} />
        <span
          className={cn(
            "flex-1 truncate text-[12px]",
            open
              ? "font-semibold text-text"
              : stageNotReached
                ? "font-medium text-faint"
                : "font-medium text-dim",
          )}
        >
          {stageLabel(stage)}
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
            {roots.length > 1 ? (
              <LegsBody
                threads={roots}
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

/** The open stage's TASKS section — the stage's live, LLM-authored checklist. Exported for the navigator's
 *  Main row, whose fold shows the brain session's own list (`pipelineMainTasks`) the same way. */
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

/** The design's agent states — a review child's wire `ThreadStatus` folds onto these. */
type AgentDisplay = "pending" | "in_progress" | "done" | "skipped" | "failed";

/** Map a review CHILD thread's step + condition to its navigator display state. */
function childDisplay(
  status: ThreadStatus,
  condition: ThreadCondition,
): AgentDisplay {
  if (condition === "failed") return "failed"; // the lens did NOT run (e.g. engine/auth error) — surface it
  if (condition === "skipped") return "skipped"; // nothing to do (unknown lens / no diff) — terminal, not a failure
  if (status === "done") return "done"; // terminal — the lens ran clean
  if (status === "pending") return "pending";
  return "in_progress"; // planning / reviewing / executing / auto_fixing
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
          state={postReviewState(postReview.status, postReview.condition)}
          selected={laneNode === postReview.id}
          onOpen={() => onSelectNode(postReview.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * The LEGS body (context-rot rotation) — one NAVIGABLE row per sequential builder thread ("Leg") in a build
 * stage. Each rotated builder is a first-class thread: clicking a Leg opens that thread's own transcript.
 * Rendered only once a build stage has rotated ≥1× (2+ builder legs); a single-leg stage shows nothing here
 * (its one thread is addressed by the stage header itself).
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
          index={i}
          state={laneState(leg.status, leg.condition, drafted)}
          selected={laneNode === leg.id}
          onOpen={() => onSelectNode(leg.id)}
        />
      ))}
    </div>
  );
}

/** One Leg — a navigable single-line row (session dot · "Leg N" · status word). Opens that builder thread's
 *  own transcript (mirrors the review-child rows). */
function LegRow({
  index,
  state,
  selected,
  onOpen,
}: {
  index: number;
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
          : state === "blocked"
            ? "blocked"
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
        Leg {index + 1}
      </span>
      <span className="shrink-0 text-[10px] font-medium" style={{ color: wordColor }}>
        {word}
      </span>
    </button>
  );
}

/** The post-review fix child's step + condition → its row's display states. */
function postReviewState(
  status: ThreadStatus,
  condition: ThreadCondition,
): "queued" | "running" | "done" | "failed" {
  if (condition === "failed") return "failed"; // the fix turn errored out — don't paint it done
  if (status === "pending") return "queued";
  if (
    status === "executing" ||
    status === "auto_fixing" ||
    status === "planning" ||
    status === "reviewing"
  )
    return "running";
  return "done";
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
  const d = childDisplay(c.status, c.condition);
  const word =
    d === "failed"
      ? "failed"
      : d === "done"
        ? "done"
        : d === "in_progress"
          ? "reviewing"
          : d === "skipped"
            ? "skipped"
            : "pending";
  const wordColor =
    d === "failed"
      ? "var(--red)"
      : d === "done"
        ? "var(--green)"
        : d === "in_progress"
          ? "var(--blue)"
          : "var(--faint)";
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
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[11.5px] font-semibold",
          d === "pending" || d === "skipped" ? "text-dim" : "text-text",
        )}
      >
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
  display: AgentDisplay | "queued" | "running";
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
  state: "queued" | "running" | "done" | "failed";
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
      <AgentStatusTile display={state === "queued" ? "pending" : state} />
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
