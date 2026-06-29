'use client';

import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Dot } from '@/components/ui/badges';
import { trackColor } from '@/lib/api/status';
import { trackTitle } from '@/lib/track-title';
import { useLiveTurn } from '@/lib/api/thread-stream';
import { phaseLane } from './phases';
import { durableSessionToolCounts, durableSubagentRunsByPhase, liveSubagentRunsForPhase } from './track-subagents';
import { subagentModel, subagentNode, type SubagentSummary } from './subagents';
import type { ThreadMessage } from '@/lib/api/thread-api';
import type { PipelineJob, PipelineStep, PipelineTrack, StepStatus, TrackStatus, ThreadStatus } from '@/lib/api/types';

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
  selectedNode: string | null;
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
export function PipelineTree({ job, status, messages, threadId, selectedNode, onSelectNode, isExpanded, toggle }: TreeProps) {
  const tracks = job.tracks;
  const activeIdx = tracks.findIndex((s) => isActiveTrack(s.status));
  // Failed: tracks/steps aren't persisted as `failed` (only the thread flips), so derive the halt
  // point — the in-flight track (the furthest one that's neither `done` nor `pending`) is where the run
  // stopped; later `pending` tracks were never reached. Fall back to the last non-`done` track.
  const haltIdx = status === 'failed' ? haltTrackIdx(tracks) : -1;

  // Per-track writer runs + session tool counts, derived once from the transcript.
  const runsByPhase = useMemo(() => durableSubagentRunsByPhase(messages), [messages]);
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
            sessionToolCount={toolCount}
            selectedNode={selectedNode}
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
  sessionToolCount,
  selectedNode,
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
  sessionToolCount: number;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
  isExpanded: TreeProps['isExpanded'];
  toggle: TreeProps['toggle'];
}) {
  const folderId = `sec:${s.id}`;
  const planId = `${folderId}.plan`;
  const runsId = `${folderId}.runs`;
  const dot = isHalt ? { color: 'var(--red)', pulse: false } : trackColor(s.status);
  const expanded = isExpanded(folderId, isActive || isHalt);
  // The two axes default-open only on the active/halt session; everything else folds to one row.
  const planOpen = isExpanded(planId, isActive || isHalt);
  const runsOpen = isExpanded(runsId, isActive || isHalt);
  const dim = (s.status === 'pending' && !isActive) || notReached;
  const steps = s.steps;
  const planExpected = s.status !== 'pending';
  const runDotColor = isHalt
    ? 'var(--red)'
    : runs.length === 0
      ? 'var(--border-2)'
      : isLiveTrack
        ? 'var(--accent)'
        : s.status === 'done'
          ? 'var(--green)'
          : 'var(--accent)';

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
          {/* the session caption — one line about the orchestrator run */}
          <div className="pl-[26px] pr-2 pt-0.5 font-mono text-[8.5px] text-faint">
            {sessionCaption(s.status, isHalt, isLiveTrack, sessionToolCount)}
          </div>

          {steps.length === 0 ? (
            <div className="py-1 pl-[26px] pr-2 font-mono text-[9.5px] text-faint">
              the checklist forms when this track starts
            </div>
          ) : (
            <>
              {/* plan — the checklist axis (what was asked); items open the one session transcript */}
              <div className="group flex items-center gap-[7px] rounded-sm py-1 pl-[26px] pr-2 hover:bg-surface-2">
                <button type="button" onClick={() => toggle(planId, planOpen)} className="flex flex-1 items-center gap-[7px] text-left">
                  <Caret expanded={planOpen} />
                  <Dot
                    color={planExpected ? (s.status === 'done' ? 'var(--green)' : isActive ? 'var(--accent)' : 'var(--green)') : 'var(--border-2)'}
                    pulse={isActive && !isHalt}
                    size={5}
                  />
                  <span className="flex-1 truncate font-mono text-[10.5px] text-dim">plan · {steps.length}</span>
                </button>
                {s.hasPlan ? (
                  <button
                    type="button"
                    onClick={() => onSelectNode(`secplan:${s.id}`)}
                    className="shrink-0 rounded border px-1.5 py-px font-mono text-[8px]"
                    style={{ color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
                  >
                    📄 plan.md
                  </button>
                ) : null}
              </div>
              {planOpen &&
                steps.map((p, k) => (
                  <ChecklistRow
                    key={p.id}
                    step={p}
                    index={k}
                    isHalt={isHalt}
                    selected={selectedNode === p.id}
                    onClick={() => onSelectNode(p.id)}
                  />
                ))}

              {/* runs — the fan-out axis (what executed); each opens its own subagent transcript */}
              <button
                type="button"
                onClick={() => toggle(runsId, runsOpen)}
                className="group flex items-center gap-[7px] rounded-sm py-1 pl-[26px] pr-2 text-left hover:bg-surface-2"
              >
                {runs.length === 0 && !isActive ? <Caret expanded={false} /> : <Caret expanded={runsOpen} />}
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
                  {runs.length === 0 ? 'runs' : `runs · ${runs.length}`}
                </span>
                {runs.length === 0 ? (
                  <span className="font-mono text-[8px] text-faint">
                    {isActive ? 'none yet' : s.status === 'done' ? 'direct' : '—'}
                  </span>
                ) : null}
              </button>
              {runsOpen && runs.length === 0 ? (
                <p className="py-0.5 pl-11 pr-2 font-mono text-[9px] italic leading-relaxed text-faint">
                  {isActive
                    ? 'Writer runs appear here as the session fans implementation out.'
                    : s.status === 'done'
                      ? 'This session made its edits directly — no writer subagents were spawned.'
                      : 'Runs form when this track’s session starts — the checklist is its decomposition.'}
                </p>
              ) : null}
              {runsOpen &&
                runs.map((run) => {
                  const state = runState(run, isHalt);
                  return (
                    <RunRow
                      key={run.parentId}
                      run={run}
                      state={state}
                      live={isLiveTrack && state === 'active'}
                      selected={selectedNode === subagentNode(run.parentId)}
                      onClick={() => onSelectNode(subagentNode(run.parentId))}
                    />
                  );
                })}

              {/* verify — the self-verification line that replaces the old review folder */}
              <VerifyLine status={s.status} isHalt={isHalt} />
            </>
          )}
        </div>
      )}
    </div>
  );
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

/** One checklist item — a CHECKBOX (the plan, not a run). Clicking opens the shared session transcript. */
function ChecklistRow({
  step: p,
  index,
  isHalt,
  selected,
  onClick,
}: {
  step: PipelineStep;
  index: number;
  isHalt: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const name = p.title || p.brief || `Step ${index + 1}`;
  const skipped = p.status === 'skipped';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-sm py-[3px] pl-11 pr-2 text-left hover:bg-surface-2',
        selected && 'bg-[var(--accent-soft)]',
        p.status === 'pending' && 'opacity-80',
      )}
    >
      <StepCheckbox status={p.status} isHalt={isHalt} />
      <span
        className={cn(
          'flex-1 truncate font-mono text-[10px]',
          skipped
            ? 'text-faint line-through'
            : p.status === 'failed' || (isHalt && p.status === 'building')
              ? 'text-red'
              : p.status === 'building' || p.status === 'reviewing'
                ? 'text-text'
                : 'text-dim',
        )}
      >
        {name}
      </span>
    </button>
  );
}

/** The 11px checkbox glyph for a checklist item, by step status. */
function StepCheckbox({ status, isHalt }: { status: StepStatus; isHalt: boolean }) {
  const base = 'grid h-[11px] w-[11px] shrink-0 place-items-center rounded-[2px] text-[7px]';
  if (status === 'done') {
    return (
      <span className={base} style={{ border: '1px solid var(--green)', background: 'var(--green-soft)', color: 'var(--green)' }}>
        ✓
      </span>
    );
  }
  if (status === 'failed' || (isHalt && status === 'building')) {
    return (
      <span className={base} style={{ border: '1px solid var(--red-line)', background: 'var(--red-soft)', color: 'var(--red)' }}>
        ✕
      </span>
    );
  }
  if (status === 'building' || status === 'reviewing') {
    return (
      <span className={cn(base, 'pulse-dot')} style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
        <span className="h-1 w-1 rounded-full" style={{ background: 'var(--accent)' }} />
      </span>
    );
  }
  // pending / skipped → empty box
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
          selected ? 'bg-[var(--accent-soft)]' : 'bg-surface hover:bg-surface-2',
        )}
        style={{ borderColor: 'var(--accent-line)', background: selected ? undefined : 'var(--accent-soft)' }}
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
      className={cn('flex items-center gap-2 rounded-sm py-[3px] pl-11 pr-2 text-left hover:bg-surface-2', selected && 'bg-[var(--accent-soft)]')}
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

/** The single self-verify line that folds in the old review phase — the session verifies its own work
 *  in-turn (build + tests), so there's no separate review folder. */
function VerifyLine({ status, isHalt }: { status: TrackStatus; isHalt: boolean }) {
  if (isHalt) return null;
  if (status === 'done') {
    return (
      <div className="flex items-center gap-2 pl-[26px] pr-2 py-1">
        <span className="w-[5px] shrink-0 text-center text-[11px] text-green">✓</span>
        <span className="flex-1 font-mono text-[10px] text-green">verified in-turn</span>
        <span className="font-mono text-[8px] text-faint">build · tests</span>
      </div>
    );
  }
  if (status === 'executing' || status === 'reviewing' || status === 'auto_fixing') {
    return (
      <div className="flex items-center gap-2 pl-[26px] pr-2 py-1 opacity-65">
        <span className="w-[5px] shrink-0 text-center text-[10px] text-faint">○</span>
        <span className="flex-1 font-mono text-[10px] text-faint">verify in-turn</span>
        <span className="font-mono text-[8px] text-faint">pending</span>
      </div>
    );
  }
  return null;
}

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
