'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  TicketKind,
  TicketPriority,
} from '@/lib/api/tickets-api';
import { kindColor, priorityColor } from './ticket-helpers';

export interface TicketFormValue {
  title: string;
  body: string;
  priority: TicketPriority | '';
  kind: TicketKind | '';
}

const PRIORITIES: Array<{ v: TicketPriority | ''; label: string }> = [
  { v: '', label: 'None' },
  { v: 'low', label: 'Low' },
  { v: 'medium', label: 'Medium' },
  { v: 'high', label: 'High' },
  { v: 'urgent', label: 'Urgent' },
];

const KINDS: Array<{ v: TicketKind | ''; label: string }> = [
  { v: '', label: 'None' },
  { v: 'feature', label: 'FEATURE' },
  { v: 'bug', label: 'BUG' },
  { v: 'chore', label: 'CHORE' },
];

/**
 * Create / edit a ticket. On create it lands in the backlog (captured by you); on edit only metadata
 * changes (status is driven by Atlas & threads). Presentational — the parent owns the mutation.
 */
export function TicketFormModal({
  mode,
  number,
  nextNumber,
  initial,
  busy,
  onSubmit,
  onClose,
}: {
  mode: 'create' | 'edit';
  number?: number;
  nextNumber?: number;
  initial?: Partial<TicketFormValue>;
  busy?: boolean;
  onSubmit: (value: TicketFormValue) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [priority, setPriority] = useState<TicketPriority | ''>(initial?.priority ?? '');
  const [kind, setKind] = useState<TicketKind | ''>(initial?.kind ?? '');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSubmit = title.trim().length > 0 && !busy;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit({ title: title.trim(), body: body.trim(), priority, kind });
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className="anim-pop w-[540px] max-w-[92vw] overflow-hidden rounded-lg border border-border"
        style={{ background: 'var(--panel)', boxShadow: 'var(--shadow-palette)' }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center gap-2 px-[22px] pt-[18px]">
          <div className="font-disp text-[16px] font-semibold text-text">
            {mode === 'edit' ? `Edit ticket #${number}` : 'New ticket'}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-dim transition hover:bg-surface-2 hover:text-text"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-col gap-[15px] px-[22px] pb-5 pt-4">
          <Labeled label="Title" required>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="What needs doing?"
              className="h-[38px] w-full rounded-md border border-border bg-surface px-3 text-[13px] text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
            />
          </Labeled>

          <Labeled label="Description" hint="· markdown context for Atlas">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Context, acceptance criteria, links…"
              className="h-[104px] w-full resize-none rounded-md border border-border bg-surface px-3 py-2.5 text-[12.5px] leading-relaxed text-text outline-none transition focus:border-accent focus:ring-2 focus:ring-[var(--accent-soft)]"
            />
          </Labeled>

          <div className="flex gap-[18px]">
            <div className="flex-1">
              <FieldLabel>Priority</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {PRIORITIES.map((p) => (
                  <ChipToggle
                    key={p.v || 'none'}
                    label={p.label}
                    on={priority === p.v}
                    color={p.v ? priorityColor(p.v) : 'var(--dim)'}
                    onClick={() => setPriority(p.v)}
                  />
                ))}
              </div>
            </div>
            <div className="flex-1">
              <FieldLabel>Kind</FieldLabel>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <ChipToggle
                    key={k.v || 'none'}
                    label={k.label}
                    on={kind === k.v}
                    color={k.v ? kindColor(k.v) : 'var(--dim)'}
                    onClick={() => setKind(k.v)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-border px-[22px] py-3.5" style={{ background: 'var(--surface-2)' }}>
          <div className="font-mono text-[9.5px] text-faint">
            {mode === 'create'
              ? `Lands in the backlog · #${nextNumber ?? '—'} · captured by you`
              : 'Editing metadata · status is driven by Atlas & threads'}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="grid h-[34px] place-items-center rounded-md border border-border px-4 text-[12px] font-semibold text-dim transition hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="grid h-[34px] place-items-center rounded-md px-[18px] text-[12px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed"
            style={
              canSubmit
                ? { background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }
                : { background: 'var(--surface-3)', color: 'var(--faint)', opacity: 0.7 }
            }
          >
            {mode === 'edit' ? 'Save changes' : 'Create ticket'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-[60] grid place-items-center p-8"
      style={{ background: 'rgba(0,0,0,0.34)' }}
      onMouseDown={onClose}
    >
      {children}
    </div>
  );
}

function Labeled({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-dim">
        {label}
        {required ? <span className="text-accent"> *</span> : null}
        {hint ? <span className="font-normal text-faint"> {hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-[7px] text-[11px] font-semibold text-dim">{children}</div>;
}

function ChipToggle({
  label,
  on,
  color,
  onClick,
}: {
  label: string;
  on: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('select-none rounded-md border px-[9px] py-1 font-mono text-[9.5px] font-semibold transition')}
      style={
        on
          ? { background: color, borderColor: color, color: '#fff' }
          : { background: 'transparent', borderColor: 'var(--border-2)', color }
      }
    >
      {label}
    </button>
  );
}
