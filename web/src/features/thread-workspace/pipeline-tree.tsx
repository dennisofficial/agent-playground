'use client';

import type { MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Dot } from '@/components/ui/badges';
import { phaseColor, sectionColor } from '@/lib/api/status';
import { sectionTitle } from '@/lib/section-brief';
import type { PipelineJob, PipelinePhase, PipelineSection, SectionStatus, ThreadStatus } from '@/lib/api/types';

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

/** An empty 12px slot so leaf rows align under their caret-bearing siblings. */
export function CaretSpacer() {
  return <span className="inline-block w-3 shrink-0" aria-hidden />;
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

/** The hollow strikethrough dot for a skipped session (handoff §Dots). */
function SkippedDot() {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: 5, height: 5, border: '1.5px solid var(--faint)', background: 'transparent' }}
      aria-hidden
    />
  );
}

// ── status helpers ───────────────────────────────────────────────────────────────────────────────

const ACTIVE_SECTION: SectionStatus[] = ['planning', 'reviewing', 'awaiting_approval', 'executing', 'auto_fixing'];
const isActiveSection = (s: SectionStatus) => ACTIVE_SECTION.includes(s);

/** The halt section for a failed thread: the furthest in-flight (non-done, non-pending) section, else the
 *  last non-done one. Exported so the navigator's halt banner derives the same index. */
export function haltSectionIdx(sections: { status: SectionStatus }[]): number {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const st = sections[i].status;
    if (st !== 'done' && st !== 'pending') return i;
  }
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].status !== 'done') return i;
  }
  return -1;
}

// ── the pipeline folder tree ─────────────────────────────────────────────────────────────────────

export interface TreeProps {
  job: PipelineJob;
  status: ThreadStatus;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
  /** Resolve a folder's expanded state — explicit user override, else the status-derived default. */
  isExpanded: (folderId: string, fallback: boolean) => boolean;
  /** Toggle a folder, passing its current expanded value so the override flips it. */
  toggle: (folderId: string, currentlyExpanded: boolean) => void;
}

/**
 * The PIPELINE folder tree (running / paused / done / failed). Four nesting levels —
 * section → plan(optional)/execute/review → phase leaves (under execute) + review-agent leaves (under
 * review). Folders collapse via the `collapsed` map (owned by the navigator); the active path
 * auto-expands down to the live phase. Sections/phases are real (`/pipeline`); review lenses are
 * placeholder (ephemeral, never persisted). Clicking a leaf opens it in the work column.
 */
export function PipelineTree({ job, status, selectedNode, onSelectNode, isExpanded, toggle }: TreeProps) {
  const sections = job.sections;
  const activeIdx = sections.findIndex((s) => isActiveSection(s.status));
  // Failed: sections/phases aren't persisted as `failed` (only the thread flips), so derive the halt
  // point — the in-flight section (the furthest one that's neither `done` nor `pending`) is where the run
  // stopped; later `pending` sections were never reached. Fall back to the last non-`done` section.
  const haltIdx = status === 'failed' ? haltSectionIdx(sections) : -1;

  if (sections.length === 0) {
    return <p className="px-2 py-2 font-mono text-[10.5px] text-faint">No sections yet.</p>;
  }

  return (
    <div className="flex flex-col gap-px">
      {sections.map((s, i) => (
        <SectionNode
          key={s.id}
          section={s}
          index={i}
          isHalt={i === haltIdx}
          isActive={i === activeIdx}
          notReached={haltIdx !== -1 && i > haltIdx}
          paused={status === 'paused'}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          isExpanded={isExpanded}
          toggle={toggle}
        />
      ))}
    </div>
  );
}

function SectionNode({
  section: s,
  index,
  isHalt,
  isActive,
  notReached,
  paused,
  selectedNode,
  onSelectNode,
  isExpanded,
  toggle,
}: {
  section: PipelineSection;
  index: number;
  isHalt: boolean;
  isActive: boolean;
  notReached: boolean;
  paused: boolean;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
  isExpanded: TreeProps['isExpanded'];
  toggle: TreeProps['toggle'];
}) {
  const folderId = `sec:${s.id}`;
  const execId = `${folderId}.exec`;
  const revId = `${folderId}.rev`;
  const dot = isHalt ? { color: 'var(--red)', pulse: false } : sectionColor(s.status);
  const expanded = isExpanded(folderId, isActive || isHalt);
  // Folders default-open only on the active/halt path; everything else folds.
  const execOpen = isExpanded(execId, isActive || isHalt);
  const revOpen = isExpanded(revId, false);
  const dim = (s.status === 'pending' && !isActive) || notReached;
  const planExpected = s.status !== 'pending';

  return (
    <div className="flex flex-col">
      {/* §section — a folder row (toggles; does not navigate) */}
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
          §{index + 1} {sectionTitle(s.brief)}
        </span>
      </button>

      {expanded && (
        <div className={cn('flex flex-col gap-px', paused && 'opacity-70')}>
          {/* plan — optional leaf */}
          {s.hasPlan && (
            <LeafRow
              level={2}
              caret="spacer"
              dotColor={planExpected ? 'var(--green)' : 'var(--border-2)'}
              label="plan"
              selected={selectedNode === `secplan:${s.id}`}
              onClick={() => onSelectNode(`secplan:${s.id}`)}
              badge="plan.md"
            />
          )}

          {/* execute — folder of phase leaves */}
          <FolderRow
            level={2}
            label="execute"
            dotColor={dot.color}
            dotPulse={isActive && !isHalt}
            expanded={execOpen}
            onToggle={() => toggle(execId, execOpen)}
          />
          {execOpen &&
            s.phases.map((p, pi) => {
              const inFlight = p.status === 'building' || p.status === 'reviewing';
              return (
                <PhaseLeaf
                  key={p.id}
                  phase={p}
                  index={pi}
                  live={isActive && !isHalt && !paused && inFlight}
                  halted={isHalt && inFlight}
                  selected={selectedNode === p.id}
                  onClick={() => onSelectNode(p.id)}
                />
              );
            })}
          {execOpen && s.phases.length === 0 && (
            <div className="py-1 pl-12 pr-2 font-mono text-[9.5px] text-faint">phases form when this section starts</div>
          )}

          {/* review — folder of review-agent lenses (placeholder; ephemeral findings) */}
          <FolderRow
            level={2}
            label="review"
            dotColor={s.status === 'done' ? 'var(--green)' : s.status === 'reviewing' ? 'var(--accent)' : 'var(--border-2)'}
            dotPulse={s.status === 'reviewing'}
            expanded={revOpen}
            onToggle={() => toggle(revId, revOpen)}
          />
          {revOpen &&
            REVIEW_LENSES.map((lens) => (
              <LeafRow
                key={lens}
                level={3}
                caret="none"
                dotColor={s.status === 'done' ? 'var(--green)' : s.status === 'reviewing' ? 'var(--accent)' : 'var(--border-2)'}
                dotPulse={s.status === 'reviewing'}
                label={lens}
                selected={selectedNode === `rev:${s.id}:${lens}`}
                onClick={() => onSelectNode(`rev:${s.id}:${lens}`)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

const REVIEW_LENSES = ['best-practices', 'correctness', 'consistency'] as const;

/** A sub-stage / leaf row. `level` drives the indent (2 → 26px, 3 → 48px); `caret` reserves the slot. */
function LeafRow({
  level,
  caret,
  dotColor,
  dotPulse,
  label,
  badge,
  selected,
  onClick,
}: {
  level: 2 | 3;
  caret: 'spacer' | 'none';
  dotColor: string;
  dotPulse?: boolean;
  label: string;
  badge?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-[7px] rounded-sm py-1 pr-2 text-left hover:bg-surface-2',
        level === 2 ? 'pl-[26px]' : 'pl-12',
        selected && 'bg-[var(--accent-soft)]',
      )}
    >
      {caret === 'spacer' ? <CaretSpacer /> : null}
      <Dot color={dotColor} pulse={dotPulse} size={5} />
      <span className="flex-1 truncate font-mono text-[10.5px] text-dim">{label}</span>
      {badge ? (
        <span
          className="rounded border px-1.5 py-px font-mono text-[8px]"
          style={{ color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          📄 {badge}
        </span>
      ) : null}
    </button>
  );
}

/** A collapsible folder row (execute / review) at level 2. Toggles only — never navigates. */
function FolderRow({
  level,
  label,
  dotColor,
  dotPulse,
  expanded,
  onToggle,
}: {
  level: 2;
  label: string;
  dotColor: string;
  dotPulse?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn('group flex items-center gap-[7px] rounded-sm py-1 pr-2 text-left hover:bg-surface-2', 'pl-[26px]')}
    >
      <Caret expanded={expanded} />
      <Dot color={dotColor} pulse={dotPulse} size={5} />
      <span className="flex-1 truncate font-mono text-[10.5px] text-dim">{label}</span>
    </button>
  );
}

/** A phase (Claude Code session) leaf at level 3 — or the live session card when it's the running one. */
function PhaseLeaf({
  phase: p,
  index,
  live,
  halted,
  selected,
  onClick,
}: {
  phase: PipelinePhase;
  index: number;
  live: boolean;
  /** The in-flight phase of a failed thread's halt section — render red, not a live card. */
  halted?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const name = `phase ${index + 1}${p.title ? ` · ${p.title}` : ''}`;

  if (live) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'ml-12 mb-0.5 mr-2 flex flex-col rounded-sm border px-2.5 py-1.5 text-left transition',
          selected ? 'bg-[var(--accent-soft)]' : 'bg-surface hover:bg-surface-2',
        )}
        style={{ borderColor: 'var(--accent-line)' }}
      >
        <div className="flex items-center gap-2">
          <Dot color="var(--accent)" pulse size={5} />
          <span className="flex-1 truncate font-mono text-[10px] font-semibold text-accent">{name}</span>
          <span className="font-mono text-[8px] text-dim">live</span>
        </div>
        {p.brief ? <span className="mt-0.5 truncate font-mono text-[8.5px] text-faint">{p.brief}</span> : null}
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
          <div
            className="prog-sweep h-full w-2/5 rounded-full"
            style={{ background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }}
          />
        </div>
      </button>
    );
  }

  const dot = halted ? { color: 'var(--red)', pulse: false } : phaseColor(p.status);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-[7px] rounded-sm py-[3px] pl-12 pr-2 text-left hover:bg-surface-2',
        p.status === 'pending' && !halted && 'opacity-60',
        selected && 'bg-[var(--accent-soft)]',
      )}
    >
      {p.status === 'skipped' ? <SkippedDot /> : <Dot color={dot.color} pulse={dot.pulse} size={5} />}
      <span
        className={cn(
          'flex-1 truncate font-mono text-[10px]',
          p.status === 'skipped' ? 'text-faint line-through' : halted ? 'font-semibold text-red' : 'text-dim',
        )}
      >
        {name}
      </span>
    </button>
  );
}
