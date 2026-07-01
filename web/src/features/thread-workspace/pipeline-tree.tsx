'use client';

import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Dot } from '@/components/ui/badges';
import { threadColor } from '@/lib/api/status';
import { threadTitle } from '@/lib/thread-title';
import { useLiveTurn } from '@/lib/api/thread-stream';
import { phaseLane } from './phases';
import { durableTaskListByPhase, liveTaskListForPhase, type TaskItem } from './thread-todos';
import type { ThreadMessage } from '@/lib/api/thread-api';
import type { PipelineJob, PipelineThread, JobStatus, ThreadStatus } from '@/lib/api/types';

// ── shared nav primitives (also used by the navigator skeleton) ──────────────────────────────────

/** A 12px disclosure caret — chevron that rotates 0°→90° on expand (handoff §Caret). */
export function Caret({ expanded, onClick }: { expanded: boolean; onClick?: (e: MouseEvent) => void }) {
  return (
    <span
      onClick={onClick}
      className="inline-flex w-3 shrink-0 items-center justify-center text-faint group-hover:text-text"
      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .12s' }}
      aria-hidden
    >
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </span>
  );
}

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

const ACTIVE_THREAD: ThreadStatus[] = ['planning', 'reviewing', 'awaiting_approval', 'executing', 'auto_fixing'];
const isActiveThread = (s: ThreadStatus) => ACTIVE_THREAD.includes(s);

/** A track that has begun (or finished) building — so it owns a real task list worth showing. */
const STARTED_THREAD: ThreadStatus[] = ['executing', 'auto_fixing', 'reviewing', 'done'];
const isStartedThread = (s: ThreadStatus) => STARTED_THREAD.includes(s);

/** The halt track for a failed thread: the furthest in-flight (non-done, non-pending) track, else the
 *  last non-done one. Exported so the navigator's halt banner derives the same index. */
export function haltThreadIdx(tracks: { status: ThreadStatus }[]): number {
  for (let i = tracks.length - 1; i >= 0; i -= 1) {
    const st = tracks[i].status;
    if (st !== 'done' && st !== 'pending') return i;
  }
  for (let i = tracks.length - 1; i >= 0; i -= 1) {
    if (tracks[i].status !== 'done') return i;
  }
  return -1;
}

/** The unique anchor step ids of a track's steps, in order. In the orchestrate model a track collapses to
 *  ONE batch → one anchor (= one session); a legacy multi-batch track yields several. */
function threadAnchorIds(track: PipelineThread): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of track.steps) {
    if (!seen.has(p.anchorStepId)) {
      seen.add(p.anchorStepId);
      out.push(p.anchorStepId);
    }
  }
  return out;
}

/** The live phase lane to subscribe to for an in-flight track — the building step's anchor, else its first. */
function liveAnchorOf(track: PipelineThread): string | null {
  const building = track.steps.find((p) => p.status === 'building' || p.status === 'reviewing');
  if (building) return building.anchorStepId;
  return threadAnchorIds(track)[0] ?? null;
}

// ── the THREADS tree — a flat thread list; the open/running thread expands to its live task list ─────

export interface TreeProps {
  job: PipelineJob;
  status: JobStatus;
  /** The thread transcript — the source for each thread-session's task list (folded from its task-tool calls). */
  messages: ThreadMessage[];
  /** The open thread id — to subscribe to the active thread's live `phase:<anchor>` lane. */
  threadId: string;
  /** The LEFT pane's open lane (`?lane=`) — the selected thread; drives the orange highlight + task expand. */
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}

/**
 * The THREADS build lanes — one row per thread (formerly "track"). Each thread is one orchestrator session;
 * its **subitems are the live task list** the session + its workers maintain via the SDK task tools
 * (`TaskCreate`/`TaskUpdate`), folded from the transcript (see {@link durableTaskListByPhase}). The task list
 * shows under the thread that's currently building (live progress) and under any started thread you open in
 * the left pane. Draft threads (pre-approval) render as bare rows — no steps, no tasks (they form at run).
 */
export function PipelineTree({ job, status, messages, threadId, laneNode, onSelectNode }: TreeProps) {
  const tracks = job.tracks;
  const activeIdx = tracks.findIndex((s) => isActiveThread(s.status));
  // Failed: tracks aren't persisted as `failed` (only the thread flips), so derive the halt point — the
  // in-flight track (furthest non-`done`/non-`pending`) is where the run stopped; later ones never ran.
  const haltIdx = status === 'failed' ? haltThreadIdx(tracks) : -1;

  // Every thread-session's task list, folded once from the transcript's task-tool calls.
  const tasksByPhase = useMemo(() => durableTaskListByPhase(messages), [messages]);

  // Only ONE thread executes at a time — a single live subscription (the active thread's phase lane) carries
  // its live task list. Hooks can't be conditional, so an inactive tree reads a dead lane.
  const activeThread = activeIdx === -1 ? null : tracks[activeIdx];
  const activeAnchor = activeThread ? liveAnchorOf(activeThread) : null;
  const live = useLiveTurn(threadId, activeAnchor ? phaseLane(activeAnchor) : '__none__');
  const liveTasks = useMemo(
    () => (activeAnchor && live ? liveTaskListForPhase(live.blocks) : []),
    [activeAnchor, live],
  );

  return (
    <>
      {tracks.map((s, i) => {
        const isActive = i === activeIdx;
        const anchors = threadAnchorIds(s);
        const durableTasks = anchors.flatMap((a) => tasksByPhase.get(a) ?? []);
        // Live wins for the active thread (the mid-turn list before durable rows persist at turn end).
        const tasks = isActive && liveTasks.length > 0 ? liveTasks : durableTasks;
        return (
          <ThreadRow
            key={s.id}
            track={s}
            index={i}
            threadStatus={status}
            isActive={isActive}
            isHalt={i === haltIdx}
            notReached={haltIdx !== -1 && i > haltIdx}
            tasks={tasks}
            selected={laneNode === s.id}
            onSelect={() => onSelectNode(s.id)}
          />
        );
      })}
    </>
  );
}

/** One thread row — status dot · §N title · scope tag · task count · chevron. Opens in the LEFT pane; when
 *  it's the building thread (or a started thread you've opened) it expands into its live task list. */
function ThreadRow({
  track: s,
  index,
  threadStatus,
  isActive,
  isHalt,
  notReached,
  tasks,
  selected,
  onSelect,
}: {
  track: PipelineThread;
  index: number;
  threadStatus: JobStatus;
  isActive: boolean;
  isHalt: boolean;
  notReached: boolean;
  tasks: TaskItem[];
  selected: boolean;
  onSelect: () => void;
}) {
  // Pre-approval every thread is a draft (dashed dot, no task list — the plan shows only the threads).
  const drafted = threadStatus === 'planning' || threadStatus === 'awaiting_approval';
  const started = !drafted && isStartedThread(s.status);
  const live = tasks.filter((t) => t.status !== 'dropped');
  const done = live.filter((t) => t.status === 'completed').length;
  const dim = notReached || (!started && !drafted && !isActive);
  // Show the task list under the building thread (live progress) + under any started thread you open.
  const showTasks = started && (isActive || selected) && live.length > 0;
  const count = started ? `${done}/${live.length}` : s.steps.length > 0 ? String(s.steps.length) : '';
  const tag = s.type && s.type !== 'general' ? s.type : null;

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-2',
          selected && 'nav-selected',
          dim && 'opacity-60',
        )}
      >
        <ThreadDot track={s} drafted={drafted} isHalt={isHalt} notReached={notReached} />
        <span
          className={cn(
            'flex-1 truncate text-[11.5px] font-semibold',
            selected ? 'text-text' : dim ? 'text-faint' : 'text-dim',
          )}
        >
          §{index + 1} {threadTitle(s.brief)}
        </span>
        {tag ? (
          <span className="shrink-0 font-mono text-[7px] font-bold uppercase tracking-[0.07em] text-faint">{tag}</span>
        ) : null}
        {count ? <span className="shrink-0 font-mono text-[9px] text-faint">{count}</span> : null}
        <span className="w-2 shrink-0 text-[11px] font-semibold text-border-2">›</span>
      </button>
      {showTasks ? <TaskSublist tasks={live} /> : null}
    </>
  );
}

/** The thread's status dot — dashed while drafted (pre-approval), red on the halt, muted when unreached,
 *  else the track-status color (green done · accent building · grey pending). */
function ThreadDot({
  track: s,
  drafted,
  isHalt,
  notReached,
}: {
  track: PipelineThread;
  drafted: boolean;
  isHalt: boolean;
  notReached: boolean;
}) {
  if (isHalt) return <Dot color="var(--red)" size={9} />;
  if (drafted)
    return (
      <span
        className="h-[9px] w-[9px] shrink-0 rounded-full"
        style={{ border: '1.5px dashed var(--border-2)', background: 'transparent' }}
        aria-hidden
      />
    );
  if (notReached) return <Dot color="var(--border-2)" size={9} />;
  const { color, pulse } = threadColor(s.status);
  return <Dot color={color} pulse={pulse} size={9} />;
}

/** The thread's task list — the session + workers' live decomposition (SDK task tools), indented under the
 *  thread row with a "TASKS · done/total" header. A `dropped` task stays struck-through (per the design). */
function TaskSublist({ tasks }: { tasks: TaskItem[] }) {
  const done = tasks.filter((t) => t.status === 'completed').length;
  return (
    <div
      className="mb-2 ml-[18px] mt-0.5 flex flex-col gap-2 border-l pl-2.5 pt-1.5"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[7px] font-bold uppercase tracking-[0.1em] text-faint">TASKS</span>
        <span className="pulse-dot h-1 w-1 rounded-full" style={{ background: 'var(--accent)' }} />
        <span className="font-mono text-[7px] font-bold text-accent">
          {done}/{tasks.length}
        </span>
      </div>
      {tasks.map((t) => (
        <div key={t.id} className="flex items-center gap-2">
          <TaskCheckbox status={t.status} />
          <span
            className={cn(
              'font-mono text-[9.5px] leading-tight',
              t.status === 'completed'
                ? 'text-dim'
                : t.status === 'in_progress'
                  ? 'text-text'
                  : t.status === 'dropped'
                    ? 'text-faint line-through'
                    : 'text-faint',
            )}
          >
            {t.subject}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The 11px checkbox glyph for a task item, by task status. */
function TaskCheckbox({ status }: { status: TaskItem['status'] }) {
  const base = 'grid h-[11px] w-[11px] shrink-0 place-items-center rounded-[2px] text-[7px]';
  if (status === 'completed') {
    return (
      <span className={base} style={{ border: '1px solid var(--green)', background: 'var(--green-soft)', color: 'var(--green)' }}>
        ✓
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className={cn(base, 'pulse-dot')} style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
        <span className="h-1 w-1 rounded-full" style={{ background: 'var(--accent)' }} />
      </span>
    );
  }
  // pending / dropped → empty box
  return <span className={base} style={{ border: '1px solid var(--border-2)', background: 'transparent' }} />;
}
