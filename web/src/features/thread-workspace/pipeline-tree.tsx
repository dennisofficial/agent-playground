'use client';

import { ChevronDown, ChevronRight, FileText, Link2, Lock, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Dot } from '@/components/ui/badges';
import { sectionColor } from '@/lib/api/status';
import type { PipelineJob, SectionStatus } from '@/lib/api/types';

const SECTION_LABEL: Record<SectionStatus, string> = {
  pending: 'pending',
  planning: 'planning',
  reviewing: 'reviewing',
  awaiting_approval: 'awaiting',
  executing: 'running',
  auto_fixing: 'auto-fix',
  done: 'done',
  failed: 'failed',
};

/** A sub-stage's progress within a section. */
type Stage = 'done' | 'active' | 'pending' | 'failed';

const STAGE_DOT: Record<Stage, { color: string; pulse: boolean }> = {
  done: { color: 'var(--green)', pulse: false },
  active: { color: 'var(--accent)', pulse: true },
  pending: { color: 'var(--border-2)', pulse: false },
  failed: { color: 'var(--red)', pulse: false },
};

/**
 * Derive each section's plan → review → execute → auto-fix sub-stage states from its single `status`. The
 * `/pipeline` API exposes sections (id, ordinal, brief, status) but NOT phases, so the four sub-stages are
 * deterministic scaffolding and individual phase rows (e.g. "phase-1 · model") are intentionally omitted.
 */
function subStages(status: SectionStatus): { plan: Stage; review: Stage; execute: Stage; autofix: Stage } {
  switch (status) {
    case 'planning':
      return { plan: 'active', review: 'pending', execute: 'pending', autofix: 'pending' };
    case 'reviewing':
    case 'awaiting_approval':
      return { plan: 'done', review: 'active', execute: 'pending', autofix: 'pending' };
    case 'executing':
      return { plan: 'done', review: 'done', execute: 'active', autofix: 'pending' };
    case 'auto_fixing':
      return { plan: 'done', review: 'done', execute: 'done', autofix: 'active' };
    case 'done':
      return { plan: 'done', review: 'done', execute: 'done', autofix: 'done' };
    case 'failed':
      return { plan: 'done', review: 'done', execute: 'failed', autofix: 'pending' };
    default:
      return { plan: 'pending', review: 'pending', execute: 'pending', autofix: 'pending' };
  }
}

/**
 * The navigator pipeline tree (running / paused). Conversation + the CONTEXT docs + the real sections from
 * `/pipeline`, each expanded into its plan / review / execute / auto-fix sub-stages (derived — see
 * `subStages`). The running section is highlighted and its execute stage shows a live progress bar.
 * Clicking a node opens it in the work column (Phase mode).
 */
export function PipelineTree({
  job,
  selectedNode,
  convoActive,
  onConversation,
  onSelectNode,
}: {
  job: PipelineJob;
  selectedNode: string | null;
  convoActive: boolean;
  onConversation: () => void;
  onSelectNode: (node: string) => void;
}) {
  const activeIdx = job.sections.findIndex(
    (s) => s.status !== 'done' && s.status !== 'pending' && s.status !== 'failed',
  );
  const activeNo = activeIdx === -1 ? job.sections.length : activeIdx + 1;

  return (
    <div className="flex flex-col gap-px">
      <NavRow icon={<MessageSquare size={13} className="text-accent" />} active={convoActive} onClick={onConversation}>
        <span className="flex-1 text-[12px] font-semibold">Conversation</span>
        <span className="font-mono text-[8px] text-faint">main thread</span>
      </NavRow>

      <SectionLabel>CONTEXT</SectionLabel>
      <NavRow icon={<FileText size={12} />} active={selectedNode === 'plan'} onClick={() => onSelectNode('plan')}>
        <span className="flex-1 font-mono text-[11px]">plan.md</span>
        <span className="font-mono text-[8px] text-faint">overview</span>
      </NavRow>
      <NavRow icon={<Lock size={12} />} active={selectedNode === 'decision'} onClick={() => onSelectNode('decision')}>
        <span className="flex-1 font-mono text-[11px] text-dim">decision-record.md</span>
      </NavRow>
      <div className="flex items-center gap-2.5 px-2 py-1.5 text-dim">
        <Link2 size={12} />
        <span className="flex-1 text-[11px] text-dim">tracker ↗</span>
      </div>

      <div className="flex items-center gap-2 px-2 pb-1.5 pt-4">
        <span className="font-mono text-[9px] tracking-[0.16em] text-faint">PIPELINE</span>
        <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
        <span className="font-mono text-[9px] text-dim">
          §{Math.min(activeNo, job.sections.length || 1)} / {job.sections.length}
        </span>
      </div>

      {job.sections.length === 0 ? (
        <p className="px-2 py-2 font-mono text-[10.5px] text-faint">No sections yet.</p>
      ) : (
        job.sections.map((s, i) => {
          const head = sectionColor(s.status);
          const running = s.status === 'executing' || s.status === 'auto_fixing';
          const expanded = s.status !== 'pending';
          const st = subStages(s.status);
          return (
            <div key={s.id} className="flex flex-col">
              {/* section header */}
              <button
                type="button"
                onClick={() => onSelectNode(s.id)}
                className={cn(
                  'mt-0.5 flex items-center gap-2 rounded-sm px-2 py-1.5 text-left',
                  running ? '' : 'hover:bg-surface-2',
                  s.status === 'pending' && 'opacity-60',
                  selectedNode === s.id && 'bg-[var(--accent-soft)]',
                )}
                style={running ? { background: 'color-mix(in srgb, var(--accent-soft) 55%, transparent)' } : undefined}
              >
                {expanded ? (
                  <ChevronDown size={11} className="shrink-0 text-faint" />
                ) : (
                  <ChevronRight size={11} className="shrink-0 text-faint" />
                )}
                <Dot color={head.color} pulse={head.pulse} size={8} />
                <span className={cn('flex-1 truncate text-[12px] font-semibold', s.status === 'pending' && 'text-dim')}>
                  §{i + 1} {s.brief}
                </span>
                <span className="font-mono text-[9px]" style={{ color: head.color }}>
                  {SECTION_LABEL[s.status]}
                </span>
              </button>

              {expanded && (
                <>
                  <SubStage
                    label="plan"
                    state={st.plan}
                    badge={{ text: '📄 plan.md', tone: 'accent' }}
                    active={selectedNode === `secplan:${s.id}`}
                    onClick={() => onSelectNode(`secplan:${s.id}`)}
                  />
                  <SubStage label="review" state={st.review} />
                  {st.execute === 'active' ? (
                    <ExecuteLive active={selectedNode === s.id} onClick={() => onSelectNode(s.id)} />
                  ) : (
                    <SubStage label="execute" state={st.execute} />
                  )}
                  <SubStage
                    label="auto-fix"
                    state={st.autofix}
                    badge={st.autofix !== 'pending' ? { text: '3 lenses', tone: 'purple' } : undefined}
                    active={selectedNode === `autofix:${s.id}`}
                    onClick={() => onSelectNode(`autofix:${s.id}`)}
                  />
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/** One indented sub-stage row (plan / review / execute / auto-fix), dot-colored by its state. */
function SubStage({
  label,
  state,
  badge,
  active,
  onClick,
}: {
  label: string;
  state: Stage;
  badge?: { text: string; tone: 'accent' | 'purple' };
  active?: boolean;
  onClick?: () => void;
}) {
  const dot = STAGE_DOT[state];
  const cls = cn(
    'flex items-center gap-2 rounded-sm py-1 pl-7 pr-2',
    state === 'pending' && 'opacity-60',
    active && 'bg-[var(--accent-soft)]',
    onClick && 'text-left hover:bg-surface-2',
  );
  const body = (
    <>
      <Dot color={dot.color} pulse={dot.pulse} size={5} />
      <span className={cn('font-mono text-[10.5px]', state === 'pending' ? 'text-faint' : 'text-dim')}>{label}</span>
      <div className="flex-1" />
      {badge ? (
        <span
          className="rounded border px-1.5 py-px font-mono text-[8px]"
          style={
            badge.tone === 'accent'
              ? { color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
              : { color: 'var(--purple)', borderColor: 'transparent' }
          }
        >
          {badge.text}
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** The running section's execute stage — a live card with a sweeping progress bar (opens the build view). */
function ExecuteLive({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'ml-7 mb-0.5 mr-2 flex flex-col rounded-sm border px-2.5 py-1.5 text-left transition',
        active ? 'bg-[var(--accent-soft)]' : 'bg-surface hover:bg-surface-2',
      )}
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <Dot color="var(--accent)" pulse size={5} />
        <span className="font-mono text-[10px] font-semibold text-accent">execute · live</span>
        <div className="flex-1" />
        <span className="font-mono text-[8px] text-dim">live</span>
      </div>
      <div className="mt-1.5 h-[3px] overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
        <div
          className="prog-sweep h-full w-2/5 rounded-full"
          style={{ background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }}
        />
      </div>
    </button>
  );
}

function NavRow({
  icon,
  active,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2',
        active && 'bg-[var(--accent-soft)]',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1.5 pt-2 font-mono text-[9px] tracking-[0.16em] text-faint">{children}</div>
  );
}
