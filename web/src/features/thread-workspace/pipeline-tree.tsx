'use client';

import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Dot } from '@/components/ui/badges';
import { trackColor } from '@/lib/api/status';
import { trackTitle } from '@/lib/track-title';
import { useLiveTurn } from '@/lib/api/thread-stream';
import { phaseLane } from './phases';
import { durableSessionToolCounts, durableSubagentRunsByPhase, liveSubagentRunsForPhase } from './track-subagents';
import { durableTaskListByPhase, liveTaskListForPhase, type TaskItem } from './track-todos';
import { subagentModel, subagentNode, type SubagentSummary } from './subagents';
import type { ThreadMessage } from '@/lib/api/thread-api';
import type { PipelineJob, PipelineStep, PipelineTrack, ReviewAgent, TrackStatus, ThreadStatus } from '@/lib/api/types';

// The orchestrator session is always Opus (one Opus session per track fans implementation out to writer
// subagents) — shown as a chip on the track row.
const ORCHESTRATOR_MODEL = 'Opus';

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

/** A divider header (CONTEXT / PIPELINE / ARTIFACTS) — mono label, hairline rule, optional right count. */
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

const ACTIVE_TRACK: TrackStatus[] = ['planning', 'reviewing', 'awaiting_approval', 'executing', 'auto_fixing'];
const isActiveTrack = (s: TrackStatus) => ACTIVE_TRACK.includes(s);

/** The halt track for a failed thread: the furthest in-flight (non-done, non-pending) track, else the
 *  last non-done one. Exported so the navigator's halt banner derives the same index. */
export function haltTrackIdx(tracks: { status: TrackStatus }[]): number {
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
function trackAnchorIds(track: PipelineTrack): string[] {
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
function liveAnchorOf(track: PipelineTrack): string | null {
  const building = track.steps.find((p) => p.status === 'building' || p.status === 'reviewing');
  if (building) return building.anchorStepId;
  return trackAnchorIds(track)[0] ?? null;
}

/** Merge durable + live runs for a track, keyed by the spawning Task id (live wins — it carries the fresh
 *  running state mid-turn, before the durable rows are persisted at turn end). */
function mergeRuns(durable: SubagentSummary[], live: SubagentSummary[]): SubagentSummary[] {
  if (live.length === 0) return durable;
  const byId = new Map<string, SubagentSummary>();
  for (const r of durable) byId.set(r.parentId, r);
  for (const r of live) byId.set(r.parentId, r);
  return [...byId.values()];
}

type RunState = 'pending' | 'active' | 'done' | 'failed';

/** A writer run's display state. A finished run is `done`; a still-running one is `failed` on a halt track
 *  (the run that exhausted its retries), else `active`. */
function runState(run: SubagentSummary, isHalt: boolean): RunState {
  if (!run.running) return 'done';
  if (isHalt) return 'failed';
  return 'active';
}

// ── the pipeline folder tree ─────────────────────────────────────────────────────────────────────

export interface TreeProps {
  job: PipelineJob;
  status: ThreadStatus;
  /** The thread transcript — the source for each track-session's writer-subagent runs (see track-subagents.ts). */
  messages: ThreadMessage[];
  /** The open thread id — to subscribe to the active track's live `phase:<anchor>` lane. */
  threadId: string;
  /** The LEFT pane's open lane (`?lane=`) — a track/step session opens here (orange highlight). */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`) — a subagent run / review lens opens here (blue). */
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  /** Resolve a folder's expanded state — explicit user override, else the status-derived default. */
  isExpanded: (folderId: string, fallback: boolean) => boolean;
  /** Toggle a folder, passing its current expanded value so the override flips it. */
  toggle: (folderId: string, currentlyExpanded: boolean) => void;
}

/**
 * The PIPELINE folder tree (running / paused / done / failed). Each track is ONE orchestrator session
 * (one Opus turn) split across two sibling axes — `plan` (the asked-for checklist; every item opens the
 * session transcript) and `runs` (the writer subagents — `implement`/`implement-fast` — that actually
 * executed; each opens its own `subagent:` transcript) — closed by a single "verified in-turn" line (the
 * session self-verifies; the old review phase is folded in). The active session auto-expands; finished
 * ones fold shut. Steps + tracks are real (`/pipeline`); the runs are derived from the transcript.
 */
export function PipelineTree({ job, status, messages, threadId, laneNode, detailNode, onSelectNode, isExpanded, toggle }: TreeProps) {
  const tracks = job.tracks;
  const activeIdx = tracks.findIndex((s) => isActiveTrack(s.status));
  // Failed: tracks/steps aren't persisted as `failed` (only the thread flips), so derive the halt
  // point — the in-flight track (the furthest one that's neither `done` nor `pending`) is where the run
  // stopped; later `pending` tracks were never reached. Fall back to the last non-`done` track.
  const haltIdx = status === 'failed' ? haltTrackIdx(tracks) : -1;

  // Per-track writer runs + task lists + session tool counts, derived once from the transcript.
  const runsByPhase = useMemo(() => durableSubagentRunsByPhase(messages), [messages]);
  const tasksByPhase = useMemo(() => durableTaskListByPhase(messages), [messages]);
  const sessionTools = useMemo(() => durableSessionToolCounts(messages), [messages]);

  // Only ONE track executes at a time, so a single live subscription (the active track's phase lane) covers
  // the live fan-out — the writer mid-run + a live session tool count. Hooks can't be conditional, so an
  // inactive tree reads a dead lane.
  const activeTrack = activeIdx === -1 ? null : tracks[activeIdx];
  const activeAnchor = activeTrack ? liveAnchorOf(activeTrack) : null;
  const live = useLiveTurn(threadId, activeAnchor ? phaseLane(activeAnchor) : '__none__');
  const liveActive = Boolean(live?.active);
  const liveRuns = useMemo(
    () => (activeAnchor && live ? liveSubagentRunsForPhase(live.blocks) : []),
    [activeAnchor, live],
  );
  const liveTasks = useMemo(
    () => (activeAnchor && live ? liveTaskListForPhase(live.blocks) : []),
    [activeAnchor, live],
  );
  const liveToolCount =
    activeAnchor && live ? live.blocks.filter((b) => b.kind === 'tool' && !b.parentToolUseId).length : 0;

  if (tracks.length === 0) {
    return <p className="px-2 py-2 font-mono text-[10.5px] text-faint">No tracks yet.</p>;
  }

  return (
    <div className="flex flex-col gap-px">
      {tracks.map((s, i) => {
        const isActive = i === activeIdx;
        const isLiveTrack = isActive && liveActive;
        const anchors = trackAnchorIds(s);
        const durableRuns = anchors.flatMap((a) => runsByPhase.get(a) ?? []);
        const runs = mergeRuns(durableRuns, isActive ? liveRuns : []);
        // The session transcript node + the task list's join key (a track is one batch → one anchor).
        const sessionAnchor = anchors[0] ?? null;
        const durableTasks = anchors.flatMap((a) => tasksByPhase.get(a) ?? []);
        // Live wins for the active track (the mid-turn list before the durable rows persist at turn end).
        const tasks = isActive && liveTasks.length > 0 ? liveTasks : durableTasks;
        const toolCount =
          isLiveTrack && liveToolCount > 0
            ? liveToolCount
            : anchors.reduce((n, a) => n + (sessionTools.get(a) ?? 0), 0);
        return (
          <TrackSession
            key={s.id}
            track={s}
            index={i}
            isHalt={i === haltIdx}
            isActive={isActive}
            isLiveTrack={isLiveTrack}
            notReached={haltIdx !== -1 && i > haltIdx}
            paused={status === 'paused'}
            runs={runs}
            tasks={tasks}
            sessionAnchor={sessionAnchor}
            sessionToolCount={toolCount}
            laneNode={laneNode}
            detailNode={detailNode}
            onSelectNode={onSelectNode}
            isExpanded={isExpanded}
            toggle={toggle}
          />
        );
      })}
    </div>
  );
}

function TrackSession({
  track: s,
  index,
  isHalt,
  isActive,
  isLiveTrack,
  notReached,
  paused,
  runs,
  tasks,
  sessionAnchor,
  sessionToolCount,
  laneNode,
  detailNode,
  onSelectNode,
  isExpanded,
  toggle,
}: {
  track: PipelineTrack;
  index: number;
  isHalt: boolean;
  isActive: boolean;
  /** The active track AND its turn is streaming — drives the live writer card + live tool count. */
  isLiveTrack: boolean;
  notReached: boolean;
  paused: boolean;
  runs: SubagentSummary[];
  /** The orchestrator's live task list (folded from its task-tool calls); falls back to steps below. */
  tasks: TaskItem[];
  /** The batch anchor step id = the session transcript node (null until the track has steps). */
  sessionAnchor: string | null;
  sessionToolCount: number;
  laneNode: string | null;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  isExpanded: TreeProps['isExpanded'];
  toggle: TreeProps['toggle'];
}) {
  const folderId = `sec:${s.id}`;
  const tasksId = `${folderId}.tasks`;
  const agentsId = `${folderId}.agents`;
  const reviewId = `${folderId}.review`;
  const dot = isHalt ? { color: 'var(--red)', pulse: false } : trackColor(s.status);
  const expanded = isExpanded(folderId, isActive || isHalt);
  // The axes default-open only on the active/halt session; everything else folds to one row.
  const tasksOpen = isExpanded(tasksId, isActive || isHalt);
  const agentsOpen = isExpanded(agentsId, isActive || isHalt);
  const reviewOpen = isExpanded(reviewId, isActive || isHalt);
  const dim = (s.status === 'pending' && !isActive) || notReached;
  // The checklist: the orchestrator's live task list when it has one, else the pre-planned steps as a
  // fallback (older threads / sessions that edited directly without maintaining a task list).
  const taskItems = tasks.length > 0 ? tasks : stepsAsTasks(s.steps);
  const liveTasks = tasks.length > 0;
  const reviewAgents = s.reviewAgents ?? [];
  const taskExpected = s.status !== 'pending';
  const runDotColor = isHalt
    ? 'var(--red)'
    : runs.length === 0
      ? 'var(--border-2)'
      : isLiveTrack
        ? 'var(--accent)'
        : s.status === 'done'
          ? 'var(--green)'
          : 'var(--accent)';
  const openSession = sessionAnchor ? () => onSelectNode(sessionAnchor) : undefined;

  return (
    <div className="flex flex-col">
      {/* §track — the orchestrator session row (a folder; toggles, does not navigate) */}
      <button
        type="button"
        onClick={() => toggle(folderId, expanded)}
        className={cn(
          'group mt-0.5 flex items-center gap-[7px] rounded-sm px-2 py-1.5 text-left hover:bg-surface-2',
          dim && 'opacity-60',
        )}
        style={
          isHalt
            ? { background: 'var(--red-soft)', border: '1px solid var(--red-line)' }
            : isActive
              ? { background: 'color-mix(in srgb, var(--accent-soft) 55%, transparent)' }
              : undefined
        }
      >
        <Caret expanded={expanded} />
        <Dot color={dot.color} pulse={dot.pulse} size={8} />
        <span className={cn('flex-1 truncate text-[12px] font-semibold', dim && 'text-dim')}>
          §{index + 1} {trackTitle(s.brief)}
        </span>
        <ModelChip model={ORCHESTRATOR_MODEL} strong={isActive || isHalt} />
      </button>

      {expanded && (
        <div className={cn('flex flex-col gap-px', paused && 'opacity-70')}>
          {/* the session caption — one line about the orchestrator run (opens the session transcript) */}
          <button
            type="button"
            onClick={openSession}
            disabled={!openSession}
            className="pl-[26px] pr-2 pt-0.5 text-left font-mono text-[8.5px] text-faint enabled:hover:text-dim"
          >
            {sessionCaption(s.status, isHalt, isLiveTrack, sessionToolCount)}
          </button>

          {taskItems.length === 0 ? (
            <div className="py-1 pl-[26px] pr-2 font-mono text-[9.5px] italic text-faint">
              {taskExpected ? 'no task list yet — the session edited directly' : 'the task list forms when this track starts'}
            </div>
          ) : (
            <>
              {/* task list — the orchestrator's live decomposition; items open the one session transcript */}
              <button
                type="button"
                onClick={() => toggle(tasksId, tasksOpen)}
                className="group flex w-full items-center gap-[7px] rounded-sm py-1 pl-[26px] pr-2 text-left hover:bg-surface-2"
              >
                <Caret expanded={tasksOpen} />
                <Dot
                  color={taskExpected ? (s.status === 'done' ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--green)') : 'var(--border-2)'}
                  pulse={isActive && !isHalt}
                  size={5}
                />
                <span className="flex-1 truncate font-mono text-[10.5px] text-dim">task list</span>
                <span className="font-mono text-[8px] text-faint">{taskCount(taskItems, liveTasks && isActive)}</span>
              </button>
              {tasksOpen &&
                taskItems.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    selected={Boolean(sessionAnchor) && laneNode === sessionAnchor}
                    onClick={openSession}
                  />
                ))}

              {/* agents — the writer fan-out axis (what executed); each opens its own subagent transcript */}
              <button
                type="button"
                onClick={() => toggle(agentsId, agentsOpen)}
                className="group flex items-center gap-[7px] rounded-sm py-1 pl-[26px] pr-2 text-left hover:bg-surface-2"
              >
                {runs.length === 0 && !isActive ? <Caret expanded={false} /> : <Caret expanded={agentsOpen} />}
                {runs.length === 0 ? (
                  <span
                    className="inline-block shrink-0 rounded-full"
                    style={{ width: 5, height: 5, border: '1.5px dashed var(--border-2)', background: 'transparent' }}
                    aria-hidden
                  />
                ) : (
                  <Dot color={runDotColor} pulse={isLiveTrack} size={5} />
                )}
                <span className={cn('flex-1 truncate font-mono text-[10.5px]', runs.length === 0 ? 'text-faint' : 'text-dim')}>
                  {runs.length === 0 ? 'agents' : `agents · ${runs.length}`}
                </span>
                {runs.length === 0 ? (
                  <span className="font-mono text-[8px] text-faint">
                    {isActive ? 'none yet' : s.status === 'done' ? 'direct' : '—'}
                  </span>
                ) : null}
              </button>
              {agentsOpen && runs.length === 0 ? (
                <p className="py-0.5 pl-11 pr-2 font-mono text-[9px] italic leading-relaxed text-faint">
                  {isActive
                    ? 'Writer runs appear here as the session fans implementation out.'
                    : s.status === 'done'
                      ? 'This session made its edits directly — no writer subagents were spawned.'
                      : 'Agents form when this track’s session starts — the task list is its decomposition.'}
                </p>
              ) : null}
              {agentsOpen &&
                runs.map((run) => {
                  const state = runState(run, isHalt);
                  return (
                    <RunRow
                      key={run.parentId}
                      run={run}
                      state={state}
                      live={isLiveTrack && state === 'active'}
                      selected={detailNode === subagentNode(run.parentId)}
                      onClick={() => onSelectNode(subagentNode(run.parentId))}
                    />
                  );
                })}

              {/* review — the post-build fan-out; one leaf per review agent, each its own sub-page */}
              <ReviewFolder
                trackId={s.id}
                agents={reviewAgents}
                isHalt={isHalt}
                notReached={notReached}
                open={reviewOpen}
                onToggle={() => toggle(reviewId, reviewOpen)}
                detailNode={detailNode}
                onSelectNode={onSelectNode}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The task list's count chip: "N/M" completed of non-dropped, with a `live` prefix while streaming. */
function taskCount(tasks: TaskItem[], live: boolean): string {
  const active = tasks.filter((t) => t.status !== 'dropped');
  const done = active.filter((t) => t.status === 'completed').length;
  return `${live ? 'live · ' : ''}${done}/${active.length}`;
}

/** Map the pre-planned steps onto task items — the fallback checklist when the session kept no task list. */
function stepsAsTasks(steps: PipelineStep[]): TaskItem[] {
  return steps.map((p): TaskItem => {
    const subject = p.title || p.brief || p.id;
    const status: TaskItem['status'] =
      p.status === 'done'
        ? 'completed'
        : p.status === 'skipped'
          ? 'dropped'
          : p.status === 'building' || p.status === 'reviewing'
            ? 'in_progress'
            : 'pending';
    return { id: p.id, subject, status };
  });
}

/** The session caption under a track row — one honest line about the orchestrator run. */
function sessionCaption(status: TrackStatus, isHalt: boolean, isLiveTrack: boolean, tools: number): string {
  if (isHalt) return 'session halted · retries exhausted';
  if (status === 'done') return `session done${tools > 0 ? ` · ${tools} tools` : ''}`;
  if (status === 'executing' || status === 'auto_fixing' || status === 'reviewing') {
    return `session ${isLiveTrack ? 'active' : 'running'}${tools > 0 ? ` · ${tools} tools` : ''}`;
  }
  if (status === 'planning') return 'orchestrator session · drafting plan';
  if (status === 'pending') return 'session not started';
  return 'orchestrator session';
}

/** One task-list item — a CHECKBOX (the live decomposition, not a run). Clicking opens the session
 *  transcript (the whole session is one thread). A `dropped` task is struck through; a `new` one is badged. */
function TaskRow({
  task: t,
  selected,
  onClick,
}: {
  task: TaskItem;
  selected: boolean;
  onClick?: () => void;
}) {
  const dropped = t.status === 'dropped';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex items-center gap-2 rounded-sm py-[3px] pl-11 pr-2 text-left enabled:hover:bg-surface-2',
        selected && 'nav-selected',
        dropped && 'opacity-60',
      )}
    >
      <TaskCheckbox status={t.status} />
      <span
        className={cn(
          'flex-1 truncate font-mono text-[10px]',
          dropped
            ? 'text-faint line-through'
            : t.status === 'in_progress'
              ? 'text-text'
              : 'text-dim',
        )}
      >
        {t.subject}
      </span>
      {t.isNew ? (
        <span
          className="shrink-0 rounded border px-1 font-mono text-[7.5px]"
          style={{ color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          new
        </span>
      ) : dropped ? (
        <span className="shrink-0 font-mono text-[7.5px] text-faint">dropped</span>
      ) : null}
    </button>
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

/** One writer-subagent run — a DIAMOND. Clicking opens its own `subagent:` transcript. The live, in-flight
 *  run renders as a bordered card with a progress sweep (the design's Running hero). */
function RunRow({
  run,
  state,
  live,
  selected,
  onClick,
}: {
  run: SubagentSummary;
  state: RunState;
  live: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const model = subagentModel(run.type);

  if (live) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'ml-11 mb-0.5 mr-2 flex flex-col rounded-sm border px-2.5 py-1.5 text-left transition',
          selected ? 'bg-[var(--blue-soft)]' : 'bg-surface hover:bg-surface-2',
        )}
        style={{
          borderColor: selected ? 'var(--blue)' : 'var(--accent-line)',
          background: selected ? undefined : 'var(--accent-soft)',
        }}
      >
        <div className="flex items-center gap-2">
          <RunDiamond state="active" glow />
          <span className="flex-1 truncate font-mono text-[10px] font-semibold text-accent">{run.type}</span>
          {model ? <ModelChip model={model} /> : null}
          <span className="font-mono text-[8px] text-dim">live</span>
        </div>
        {run.summary ? <span className="mt-0.5 truncate font-mono text-[8.5px] text-faint">{run.summary}</span> : null}
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
          <div
            className="prog-sweep h-full w-2/5 rounded-full"
            style={{ background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }}
          />
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex items-center gap-2 rounded-sm py-[3px] pl-11 pr-2 text-left hover:bg-surface-2', selected && 'nav-selected-blue')}
    >
      <RunDiamond state={state} />
      <span className={cn('truncate font-mono text-[10px]', state === 'failed' ? 'font-semibold text-red' : 'text-dim')}>
        {run.type}
      </span>
      {model ? <ModelChip model={model} /> : null}
      <span className="flex-1" />
      <span className={cn('font-mono text-[8px]', state === 'failed' ? 'text-red' : 'text-faint')}>
        {state === 'failed' ? 'failed' : `${run.toolCount} tool${run.toolCount === 1 ? '' : 's'}`}
      </span>
    </button>
  );
}

/** The 8px diamond glyph for a run row, by run state. The active run glows + pulses. */
function RunDiamond({ state, glow }: { state: RunState; glow?: boolean }) {
  const color =
    state === 'done'
      ? 'var(--green)'
      : state === 'failed'
        ? 'var(--red)'
        : state === 'active'
          ? 'var(--accent)'
          : 'var(--border-2)';
  return (
    <span
      className={cn('shrink-0', glow && 'pulse-dot')}
      style={{
        width: 8,
        height: 8,
        background: color,
        transform: 'rotate(45deg)',
        borderRadius: 1,
        boxShadow: glow ? `0 0 7px ${color}` : undefined,
      }}
      aria-hidden
    />
  );
}

/** The review fan-out folder — the post-build programmatic review agents, one leaf per agent. A folded row
 *  when collapsed; expanded it lists each agent with its per-agent status. Each leaf opens its own
 *  `rev:<trackId>:<agentId>` sub-page (resolved in step-view.tsx). */
function ReviewFolder({
  trackId,
  agents,
  isHalt,
  notReached,
  open,
  onToggle,
  detailNode,
  onSelectNode,
}: {
  trackId: string;
  agents: ReviewAgent[];
  isHalt: boolean;
  notReached: boolean;
  open: boolean;
  onToggle: () => void;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  if (agents.length === 0) return null;
  const anyRunning = agents.some((a) => a.status === 'running');
  const anyFailed = agents.some((a) => a.status === 'failed');
  const allResolved = agents.every((a) => a.status === 'passed' || a.status === 'skipped' || a.status === 'failed');
  const headColor = isHalt || notReached
    ? 'var(--border-2)'
    : anyFailed
      ? 'var(--red)'
      : anyRunning
        ? 'var(--accent)'
        : allResolved
          ? 'var(--green)'
          : 'var(--border-2)';
  const note = isHalt || notReached
    ? 'not reached'
    : anyRunning
      ? 'running'
      : anyFailed
        ? 'issues'
        : allResolved
          ? 'passed'
          : 'after build';
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={cn('group flex items-center gap-[7px] rounded-sm py-1 pl-[26px] pr-2 text-left hover:bg-surface-2', (isHalt || notReached) && 'opacity-60')}
      >
        <Caret expanded={open} />
        <Dot color={headColor} pulse={anyRunning} size={5} />
        <span className="flex-1 truncate font-mono text-[10.5px] text-dim">review · {agents.length}</span>
        <span className="font-mono text-[8px] text-faint">{note}</span>
      </button>
      {open &&
        agents.map((a) => (
          <ReviewAgentRow
            key={a.id}
            agent={a}
            selected={detailNode === `rev:${trackId}:${a.id}`}
            onClick={() => onSelectNode(`rev:${trackId}:${a.id}`)}
          />
        ))}
    </>
  );
}

/** One review-agent leaf — a round dot colored by its per-agent status, opening its review sub-page. */
function ReviewAgentRow({ agent, selected, onClick }: { agent: ReviewAgent; selected: boolean; onClick: () => void }) {
  const meta = REVIEW_STATUS[agent.status];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex items-center gap-2 rounded-sm py-[3px] pl-11 pr-2 text-left hover:bg-surface-2', selected && 'nav-selected-blue')}
    >
      <Dot color={meta.color} pulse={agent.status === 'running'} size={6} />
      <span className={cn('flex-1 truncate font-mono text-[10px]', agent.status === 'failed' ? 'text-red' : 'text-dim')}>
        {agent.label}
      </span>
      <span className={cn('font-mono text-[8px]', agent.status === 'failed' ? 'text-red' : 'text-faint')}>
        {agent.status === 'passed' && agent.findings != null && agent.findings > 0
          ? `${agent.findings} finding${agent.findings === 1 ? '' : 's'}`
          : meta.label}
      </span>
    </button>
  );
}

/** Per review-agent status → dot color + label. */
const REVIEW_STATUS: Record<ReviewAgent['status'], { color: string; label: string }> = {
  pending: { color: 'var(--border-2)', label: 'queued' },
  running: { color: 'var(--accent)', label: 'running' },
  passed: { color: 'var(--green)', label: 'passed' },
  failed: { color: 'var(--red)', label: 'failed' },
  skipped: { color: 'var(--border-2)', label: 'skipped' },
};

/** A model chip — `Opus` (darker border) or `Sonnet` (lighter), mono, hairline border. */
function ModelChip({ model, strong }: { model: string; strong?: boolean }) {
  const opus = model === 'Opus';
  return (
    <span
      className="shrink-0 rounded-[3px] border px-1 py-px font-mono text-[8px]"
      style={{
        color: opus ? 'var(--dim)' : 'var(--faint)',
        borderColor: opus || strong ? 'var(--border-2)' : 'var(--border)',
      }}
    >
      {model}
    </span>
  );
}
