'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { threadTitle } from '@/lib/thread-title';
import { useLiveTurn } from '@/lib/api/job-stream';
import { threadLane } from './phases';
import { overlayLiveTasks } from './live-tasks';
import type {
  PipelineJob,
  PipelineThread,
  PipelineReviewChild,
  TaskItem,
  JobStatus,
  ThreadStatus,
} from '@/lib/api/types';

/**
 * The Thread Navigator's THREADS region — design handoff "thread navigation": an ACCORDION. Selecting a
 * thread reveals, in place, the things the thread owns — its LLM-authored TASKS (server-folded from the
 * session's TaskCreate/TaskUpdate calls) and its read-only REVIEW AGENTS (navigable child threads on
 * `rev:<threadId>:<agentId>` nodes) capped by the navigable "Post-review fixes" row (`fix:<threadId>`) —
 * and whichever thread was open collapses (open = the selected lane, or the thread whose review agent is
 * open in the detail pane). The whole-diff master review is now just another thread in the list (rendered
 * "Master review" with no review-agents fold), not a pinned region.
 */

// ── shared nav primitives (also used by the navigator skeleton) ──────────────────────────────────

/** A divider header (SPECS / ARTIFACTS / PORTS) — mono label, hairline rule, optional right count. */
export function Divider({ label, count }: { label: string; count?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-2 pb-1.5 pt-3">
      <span className="font-mono text-[9px] tracking-[0.16em] text-faint">{label}</span>
      <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
      {count != null ? <span className="font-mono text-[9px] text-faint">{count}</span> : null}
    </div>
  );
}

// ── status helpers ───────────────────────────────────────────────────────────────────────────────

/** The halt thread for a failed job: the furthest in-flight (non-done, non-pending) thread, else the
 *  last non-done one. Exported so the navigator's halt banner derives the same index. */
export function haltThreadIdx(threads: { status: ThreadStatus }[]): number {
  for (let i = threads.length - 1; i >= 0; i -= 1) {
    const st = threads[i].status;
    if (st !== 'done' && st !== 'pending') return i;
  }
  for (let i = threads.length - 1; i >= 0; i -= 1) {
    if (threads[i].status !== 'done') return i;
  }
  return -1;
}

/** The design's four thread states — every wire `ThreadStatus` folds onto one of these. */
type LaneState = 'draft' | 'in_progress' | 'done' | 'failed';

function laneState(s: ThreadStatus, drafted: boolean): LaneState {
  if (drafted || s === 'pending') return 'draft';
  if (s === 'done') return 'done';
  if (s === 'failed' || s === 'incomplete') return 'failed'; // both are terminal halts (nothing shipped)
  return 'in_progress'; // planning / reviewing / awaiting_approval / executing / awaiting_input / auto_fixing
}

/** The open accordion's state-colored left rail + soft wash (handoff §State colors). */
function railStyle(state: LaneState, open: boolean): { borderLeftColor: string; background: string } {
  if (!open) return { borderLeftColor: 'transparent', background: 'transparent' };
  switch (state) {
    case 'in_progress':
      return {
        borderLeftColor: 'var(--accent)',
        background: 'color-mix(in srgb, var(--accent) 4.5%, transparent)',
      };
    case 'done':
      return { borderLeftColor: 'var(--green)', background: 'color-mix(in srgb, var(--green) 6%, transparent)' };
    case 'failed':
      return { borderLeftColor: 'var(--red)', background: 'color-mix(in srgb, var(--red) 5%, transparent)' };
    default:
      return {
        borderLeftColor: 'var(--border-2)',
        background: 'color-mix(in srgb, var(--slate) 5%, transparent)',
      };
  }
}

// ── status glyphs (13px status dots · spinners · discs, straight from the handoff) ────────────────

/** A spinning progress ring — faint track + rotating colored arc (`.status-spin` = the design's 1.05s). */
function SpinRing({ size = 13, color = 'var(--accent)', track = 'var(--border-2)', trackOpacity = 0.5 }: {
  size?: number;
  color?: string;
  track?: string;
  trackOpacity?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="block" aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke={track} strokeWidth="2" opacity={trackOpacity} />
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
    <svg width={size} height={size} viewBox="0 0 20 20" className="block" aria-hidden>
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
function DashedRing({ size = 13, color = 'var(--border-2)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="block" aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}

/** The 13px status glyph slot on a thread header row. */
function ThreadStatusGlyph({ state, isHalt }: { state: LaneState; isHalt: boolean }) {
  return (
    <span className="grid h-[13px] w-[13px] shrink-0 place-items-center">
      {isHalt || state === 'failed' ? (
        <span className="h-[9px] w-[9px] rounded-full" style={{ background: 'var(--red)' }} />
      ) : state === 'done' ? (
        <DoneDisc />
      ) : state === 'in_progress' ? (
        <SpinRing />
      ) : (
        <span className="h-[9px] w-[9px] rounded-full" style={{ border: '1.5px dashed var(--border-2)' }} />
      )}
    </span>
  );
}

// ── the accordion ──────────────────────────────────────────────────────────────────────────────────

export interface TreeProps {
  job: PipelineJob;
  status: JobStatus;
  /** The job id — each fold subscribes to its thread's live lane to overlay mid-turn task calls. */
  jobId: string;
  /** The LEFT pane's open lane (`?lane=`) — the selected thread. A bare thread id opens the thread's fold;
   *  a `rev:<threadId>:…`/`fix:<threadId>` lane (review agents + post-review fixes are threads too) opens
   *  its PARENT thread's fold and highlights that child row. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}

/**
 * The THREADS build lanes — one accordion fold per thread. Each thread is one orchestrator session; its
 * fold reveals the session's live TASKS (server-folded `thread.tasks`) and its REVIEW AGENTS (read-only
 * child threads → `rev:` detail nodes) with the derived Post-review fixes row. Draft threads (pre-approval
 * or not yet reached) fold to the drafting empty state.
 */
export function PipelineTree({ job, status, jobId, laneNode, onSelectNode }: TreeProps) {
  const threads = job.threads;
  // Pre-approval every thread is a draft (dashed dot, no tasks — the plan shows only the threads).
  const drafted = status === 'planning' || status === 'plan_review' || status === 'awaiting_approval';
  // Failed: threads aren't persisted as `failed` (only the job flips), so derive the halt point — the
  // in-flight thread (furthest non-`done`/non-`pending`) is where the run stopped; later ones never ran.
  const haltIdx = status === 'failed' ? haltThreadIdx(threads) : -1;

  return (
    <>
      {threads.map((s, i) => (
        <ThreadFold
          key={s.id}
          thread={s}
          index={i}
          jobId={jobId}
          drafted={drafted}
          isHalt={i === haltIdx}
          notReached={haltIdx !== -1 && i > haltIdx}
          selected={laneNode === s.id}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />
      ))}
    </>
  );
}

/**
 * One accordion fold — the clickable thread header (status glyph · label · count chip) over the open
 * body (TASKS → REVIEW children → Post-review fixes, or the draft empty state). A thread is OPEN when it is
 * the selected lane OR one of its review CHILD threads (a review lens / the post-review fix) is the open
 * lane — they ride the same LEFT pane as bare child-thread nodes. Clicking the selected header again is a
 * no-op (stays put) — navigate back to Main by clicking the Main row itself.
 */
function ThreadFold({
  thread: s,
  index,
  jobId,
  drafted,
  isHalt,
  notReached,
  selected,
  laneNode,
  onSelectNode,
}: {
  thread: PipelineThread;
  index: number;
  jobId: string;
  drafted: boolean;
  isHalt: boolean;
  notReached: boolean;
  selected: boolean;
  /** The open LEFT-pane lane node (`?lane=`) — a bare thread/child id, or null for Main. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const state = laneState(s.status, drafted);
  const children = s.children ?? [];
  const reviewLenses = children.filter((c) => c.kind === 'review_lens');
  const postReview = children.find((c) => c.kind === 'post_review') ?? null;
  // The fold stays open while any of its review children is the selected LEFT-pane lane.
  const childOpen = laneNode != null && children.some((c) => c.id === laneNode);
  const open = selected || childOpen;
  // REALTIME: fold the thread's live lane over the durable list, so mid-turn task calls tick instantly
  // (the pipeline query only refetches at turn end). Idle lanes read a dead key — cheap store lookup.
  const liveTurn = useLiveTurn(jobId, threadLane(s.id));
  const tasks = overlayLiveTasks(s.tasks ?? [], liveTurn);
  const done = tasks.filter((t) => t.status === 'completed').length;
  const isDraft = state === 'draft';
  const count = isDraft ? 'draft' : tasks.length > 0 ? `[${done}/${tasks.length}]` : '';

  return (
    <div className="border-l-[3px]" style={railStyle(state, open)}>
      <button
        type="button"
        onClick={() => onSelectNode(s.id)}
        className={cn(
          'flex w-full items-center gap-2 py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-2',
          notReached && 'opacity-60',
        )}
      >
        <ThreadStatusGlyph state={state} isHalt={isHalt} />
        <span
          className={cn(
            'flex-1 truncate text-[12px]',
            open ? 'font-semibold text-text' : notReached ? 'font-medium text-faint' : 'font-medium text-dim',
          )}
        >
          {s.isMasterReview ? 'Master review' : `§${index + 1} ${threadTitle(s.brief)}`}
        </span>
        {count ? (
          <span className="shrink-0 text-right font-mono text-[8px] text-faint">{count}</span>
        ) : null}
      </button>

      {open ? (
        isDraft ? (
          <DraftEmptyBody />
        ) : (
          <>
            <TasksBody tasks={tasks} done={done} total={tasks.length} />
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
      <span className="font-mono text-[8px] tracking-[0.12em] text-faint">{label}</span>
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

/** The open thread's TASKS section — the session's live, LLM-authored checklist. Exported for the
 *  navigator's Main row, whose fold shows the brain session's own list (`job.mainTasks`) the same way. */
export function TasksBody({ tasks, done, total }: { tasks: TaskItem[]; done: number; total: number }) {
  const ordered = [...tasks].sort(byTaskId);
  // BLOCKED is derived, not stored: a pending task whose `blockedBy` edge points at a still-incomplete
  // sibling. Completing (or deleting — it's gone from the list) a blocker clears the block by itself.
  const byId = new Map(ordered.map((t) => [t.id, t]));
  const openBlockers = (t: TaskItem): string[] =>
    t.status === 'pending'
      ? (t.blockedBy ?? []).filter((id) => {
          const b = byId.get(id);
          return b != null && b.status !== 'completed';
        })
      : [];

  // A long finished run folds away, but the last DONE_TAIL completed tasks stay pinned (a just-finished
  // task lingers there as newer ones complete, then rolls into the fold) and everything still in flight
  // (pending/in_progress/blocked/dropped) is always visible. Only the OLDER completed tasks hide, and
  // only once enough of them pile up to earn the disclosure — otherwise the pure id-ordered list renders.
  const [showDone, setShowDone] = useState(false);
  const completed = ordered.filter((t) => t.status === 'completed');
  const active = ordered.filter((t) => t.status !== 'completed');
  const hidden = completed.slice(0, Math.max(0, completed.length - DONE_TAIL));
  const tail = completed.slice(hidden.length);
  const fold = hidden.length >= DONE_FOLD_MIN;

  return (
    <div className="nav-expand mb-1.5 ml-[9px] flex flex-col gap-px">
      <BodyHeader label="TASKS" right={total > 0 ? `${done}/${total}` : '—'} />
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
              className={cn('mt-px flex-none transition-transform', showDone && 'rotate-90')}
            />
          </button>
          {showDone ? hidden.map((t) => <TaskRow key={t.id} task={t} />) : null}
          {tail.map((t) => <TaskRow key={t.id} task={t} />)}
          {active.map((t) => <TaskRow key={t.id} task={t} blockers={openBlockers(t)} />)}
        </>
      ) : (
        ordered.map((t) => <TaskRow key={t.id} task={t} blockers={openBlockers(t)} />)
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
function TaskRow({ task: t, blockers = [] }: { task: TaskItem; blockers?: string[] }) {
  const struck = t.status === 'completed' || t.status === 'dropped';
  const inProgress = t.status === 'in_progress';
  const blocked = blockers.length > 0;
  const expanded = inProgress || blocked; // the rows that earn a second line
  return (
    <div className="flex items-start gap-1.5 py-1 pl-1.5 pr-1" title={t.description || t.subject}>
      <span className="mt-px h-[13px] w-[13px] shrink-0">
        {t.status === 'completed' ? (
          <DoneDisc />
        ) : inProgress ? (
          <SpinRing />
        ) : blocked ? (
          <BlockedRing />
        ) : t.status === 'dropped' ? (
          <DashedRing color="var(--faint)" />
        ) : (
          <DashedRing />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-[11.5px] leading-[1.35]',
            inProgress ? 'text-text' : struck ? 'text-faint line-through' : 'text-dim',
          )}
        >
          {t.subject}
        </span>
        {inProgress ? (
          <span className="mt-px block font-mono text-[8px] tracking-[0.02em] text-accent">
            {(t.activeForm || t.subject) + '…'}
          </span>
        ) : blocked ? (
          <span className="mt-px block font-mono text-[8px] tracking-[0.02em]" style={{ color: 'var(--slate)' }}>
            blocked by {blockers.map((b) => `#${b}`).join(' · ')}
          </span>
        ) : null}
        {expanded && t.description ? (
          <span className="mt-0.5 block text-[10px] leading-[1.4] text-faint">{t.description}</span>
        ) : null}
      </span>
      <span className="mt-px shrink-0 font-mono text-[8px] text-faint">#{t.id}</span>
    </div>
  );
}

/** The blocked glyph — slate ring with a center dot (handoff §Task row). */
function BlockedRing({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="block" aria-hidden>
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--slate)" strokeWidth="2" />
      <circle cx="10" cy="10" r="2.7" fill="var(--slate)" />
    </svg>
  );
}

// ── REVIEW children — each review lens + the post-review fix are first-class child threads ─────────

/** The design's four agent states — a review child's wire `ThreadStatus` folds onto these. */
type AgentDisplay = 'pending' | 'in_progress' | 'done' | 'skipped';

/** Map a review CHILD thread's `ThreadStatus` to its navigator display state. */
function childDisplay(status: ThreadStatus): AgentDisplay {
  if (status === 'done' || status === 'failed') return 'done'; // terminal — the lens ran
  if (status === 'skipped') return 'skipped';
  if (status === 'pending') return 'pending';
  return 'in_progress'; // planning / reviewing / executing / auto_fixing / awaiting_*
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
          state={postReviewState(postReview.status)}
          selected={laneNode === postReview.id}
          onOpen={() => onSelectNode(postReview.id)}
        />
      ) : null}
    </div>
  );
}

/** The post-review fix child's `ThreadStatus` → its row's three display states. */
function postReviewState(status: ThreadStatus): 'queued' | 'running' | 'done' {
  if (status === 'pending') return 'queued';
  if (status === 'executing' || status === 'auto_fixing' || status === 'planning' || status === 'reviewing')
    return 'running';
  return 'done';
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
  const d = childDisplay(c.status);
  const word = d === 'done' ? 'done' : d === 'in_progress' ? 'reviewing' : d === 'skipped' ? 'skipped' : 'pending';
  const wordColor = d === 'done' ? 'var(--green)' : d === 'in_progress' ? 'var(--blue)' : 'var(--faint)';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-2 px-1.5 py-[3px] text-left transition',
        selected ? 'bg-panel shadow-[0_1px_3px_rgba(0,0,0,0.06)]' : 'hover:bg-surface-2',
      )}
    >
      <AgentStatusTile display={d} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[11.5px] font-semibold',
          d === 'pending' || d === 'skipped' ? 'text-dim' : 'text-text',
        )}
      >
        {c.brief}
      </span>
      <span className="shrink-0 font-mono text-[8px]" style={{ color: wordColor }}>
        {word}
      </span>
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke={selected ? 'var(--accent)' : 'var(--border-2)'}
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
function AgentStatusTile({ display }: { display: AgentDisplay | 'queued' | 'running' }) {
  const done = display === 'done';
  const spinning = display === 'in_progress' || display === 'running';
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded"
      style={{
        color: done ? 'var(--green)' : spinning ? 'var(--blue)' : 'var(--faint)',
        background: done ? 'var(--green-soft)' : spinning ? 'var(--blue-soft)' : 'var(--surface-3)',
      }}
    >
      {done ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : spinning ? (
        <SpinRing size={11} color="currentColor" track="currentColor" trackOpacity={0.28} />
      ) : (
        <svg width="11" height="11" viewBox="0 0 20 20" className="block" aria-hidden>
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3" />
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
  state: 'queued' | 'running' | 'done';
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Runs after the review agents finish — applies fixes and verifies. Open its transcript."
      className={cn(
        'mt-[2px] flex w-full items-center gap-2 border-t border-dashed px-1.5 pb-[3px] pt-1.5 text-left transition',
        selected ? 'bg-panel shadow-[0_1px_3px_rgba(0,0,0,0.06)]' : 'hover:bg-surface-2',
      )}
      style={{ borderColor: 'var(--border-2)' }}
    >
      <AgentStatusTile display={state === 'queued' ? 'pending' : state} />
      <span
        className={cn('min-w-0 flex-1 text-[11.5px] font-semibold', state === 'done' ? 'text-text' : 'text-dim')}
      >
        Post-review fixes
      </span>
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke={selected ? 'var(--accent)' : 'var(--border-2)'}
        strokeWidth="3"
        className="shrink-0"
        aria-hidden
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
