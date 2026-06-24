'use client';

import { ChevronDown, FileText, Link2, Lock, MessageSquare } from 'lucide-react';
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

/**
 * The navigator pipeline tree (running / paused). Conversation + the CONTEXT docs + the real sections
 * from `/pipeline`. Sections are real (id, ordinal, brief, status); the per-section sub-steps
 * (plan / execute / auto-fix) are DERIVED — the web API exposes sections, not phases — so they read as
 * lightweight, labeled scaffolding. Clicking a node opens it in the work column (Phase mode).
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
          const c = sectionColor(s.status);
          const running = s.status === 'executing' || s.status === 'auto_fixing';
          return (
            <div key={s.id} className="flex flex-col">
              <button
                type="button"
                onClick={() => onSelectNode(s.id)}
                className={cn(
                  'mt-0.5 flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2',
                  selectedNode === s.id && 'bg-[var(--accent-soft)]',
                )}
                style={
                  running
                    ? { background: 'color-mix(in srgb, var(--accent-soft) 55%, transparent)' }
                    : undefined
                }
              >
                <ChevronDown size={11} className="text-faint" />
                <Dot color={c.color} pulse={c.pulse} size={8} />
                <span className={cn('flex-1 truncate text-[12px] font-semibold', s.status === 'pending' && 'text-dim')}>
                  §{i + 1} {s.brief}
                </span>
                <span className="font-mono text-[9px]" style={{ color: c.color }}>
                  {SECTION_LABEL[s.status]}
                </span>
              </button>
              {/* DERIVED sub-steps (no phase API) — lightweight scaffolding. */}
              <SubStep
                label="plan"
                tag="📄 plan.md"
                active={selectedNode === `secplan:${s.id}`}
                onClick={() => onSelectNode(`secplan:${s.id}`)}
              />
              {(s.status === 'executing' || s.status === 'auto_fixing' || s.status === 'done') && (
                <SubStep
                  label="auto-fix"
                  tag="3 lenses"
                  active={selectedNode === `autofix:${s.id}`}
                  onClick={() => onSelectNode(`autofix:${s.id}`)}
                />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function SubStep({
  label,
  tag,
  active,
  onClick,
}: {
  label: string;
  tag: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-sm py-1 pl-8 pr-2 text-left hover:bg-surface-2',
        active && 'bg-[var(--accent-soft)]',
      )}
    >
      <span className="font-mono text-[10.5px] text-dim">{label}</span>
      <div className="flex-1" />
      <span
        className="rounded border px-1.5 py-px font-mono text-[8px] text-accent"
        style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
      >
        {tag}
      </span>
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
