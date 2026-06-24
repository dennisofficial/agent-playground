'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { orgColor, roleLabel } from '@/lib/org-display';

/**
 * Top-bar org filter — a chip showing the current rail selection ("All organizations · N orgs" or one
 * org), opening a menu to narrow the board/sidebar. It mirrors the org rail (a filter, not a switch); the
 * rail and this chip share `useOrgFilter`.
 */
export function OrgFilter() {
  const { filter, setFilter, orgs } = useOrgFilter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selected = filter === 'all' ? null : orgs.find((o) => o.id === filter);
  const label = selected ? selected.name : 'All organizations';
  const sub = selected ? `${roleLabel(selected.role)} · ${selected.status}` : `${orgs.length} orgs · one login`;
  const dotColor = selected ? orgColor(selected.id) : 'var(--faint)';

  function pick(next: 'all' | string) {
    setFilter(next);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 transition hover:bg-surface-2"
      >
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: dotColor }} />
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[11.5px] font-semibold text-text">{label}</span>
          <span className="font-mono text-[8.5px] text-faint">{sub}</span>
        </span>
        <ChevronDown size={12} className="text-faint" />
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-60 overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <FilterRow label="All organizations" sub={`${orgs.length} orgs`} dot="var(--faint)" active={filter === 'all'} onClick={() => pick('all')} />
          <div className="my-1 h-px" style={{ background: 'var(--hair)' }} />
          {orgs.map((o) => (
            <FilterRow
              key={o.id}
              label={o.name}
              sub={`${roleLabel(o.role)} · ${o.status}`}
              dot={orgColor(o.id)}
              active={filter === o.id}
              onClick={() => pick(o.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterRow({
  label,
  sub,
  dot,
  active,
  onClick,
}: {
  label: string;
  sub: string;
  dot: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-surface-2"
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: dot }} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12.5px] font-medium text-text">{label}</span>
        <span className="font-mono text-[9px] text-faint">{sub}</span>
      </span>
      {active ? <Check size={13} className="shrink-0 text-accent" /> : null}
    </button>
  );
}
