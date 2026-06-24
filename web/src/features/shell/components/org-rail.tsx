'use client';

import { LayoutGrid, Plus } from 'lucide-react';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import type { OrgSummary } from '@/lib/api/me';
import { orgColor, orgInitials, roleLabel } from '@/lib/org-display';

/**
 * Org rail (64px) — the multi-org spine. "All" (the unified board across every org) sits on top, then the
 * orgs the operator OWNS, a "JOINED" divider, then orgs they were invited to. Selecting an org is a
 * filter, not a switch (handoff north star). The dashed "＋" (create org) is a not-yet-wired affordance.
 */
export function OrgRail() {
  const { filter, setFilter, owned, joined } = useOrgFilter();

  return (
    <aside
      className="flex w-16 shrink-0 flex-col items-center gap-2 overflow-visible border-r border-border py-3"
      style={{ background: 'color-mix(in srgb, var(--panel) 78%, transparent)' }}
    >
      {/* All organizations */}
      <RailButton
        active={filter === 'all'}
        color="var(--accent)"
        onClick={() => setFilter('all')}
        tip="All organizations"
        sub="one board · no switching"
      >
        <span className="flex items-center justify-center text-dim">
          <LayoutGrid size={17} />
        </span>
      </RailButton>

      <div className="my-0.5 h-px w-6" style={{ background: 'var(--border-2)' }} />

      {owned.map((o) => (
        <OrgTile key={o.id} org={o} active={filter === o.id} onClick={() => setFilter(o.id)} />
      ))}

      {joined.length > 0 ? (
        <div className="mt-1 font-mono text-[7.5px] tracking-[0.12em] text-faint">JOINED</div>
      ) : null}
      {joined.map((o) => (
        <OrgTile key={o.id} org={o} active={filter === o.id} onClick={() => setFilter(o.id)} joined />
      ))}

      <div className="flex-1" />

      {/* Create org — not wired this phase. */}
      <button
        type="button"
        disabled
        title="Create organization — coming soon"
        className="flex h-10 w-10 cursor-not-allowed items-center justify-center rounded-[11px] border border-dashed border-border-2 text-faint"
        aria-label="Create organization (coming soon)"
      >
        <Plus size={18} strokeWidth={1.5} />
      </button>
    </aside>
  );
}

function OrgTile({
  org,
  active,
  onClick,
  joined = false,
}: {
  org: OrgSummary;
  active: boolean;
  onClick: () => void;
  joined?: boolean;
}) {
  const color = orgColor(org.id);
  return (
    <RailButton
      active={active}
      color={color}
      onClick={onClick}
      tip={org.name}
      sub={`${roleLabel(org.role)} · ${org.status}`}
    >
      <span
        className="flex h-full w-full items-center justify-center font-disp text-[13px] font-semibold text-white"
        style={{ background: color, opacity: joined ? 0.92 : 1 }}
      >
        {orgInitials(org.name)}
      </span>
    </RailButton>
  );
}

/** A 40px rail avatar with an active ring + a hover flyout tooltip (name + sub-line). */
function RailButton({
  active,
  color,
  onClick,
  tip,
  sub,
  children,
}: {
  active: boolean;
  color: string;
  onClick: () => void;
  tip: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="group relative flex items-center justify-center" style={{ color }}>
      <span
        className="block h-10 w-10 overflow-hidden rounded-[11px] border border-border-2 bg-surface-3 transition-all duration-150 group-hover:-translate-y-px group-hover:rounded-[9px]"
        style={active ? { borderRadius: 9, boxShadow: '0 0 0 2px var(--bg), 0 0 0 4px currentColor' } : undefined}
      >
        {children}
      </span>
      {/* flyout tooltip */}
      <span
        className="pointer-events-none absolute left-[52px] top-1/2 z-[60] flex -translate-y-1/2 -translate-x-1.5 flex-col gap-0.5 whitespace-nowrap rounded-md border border-border-2 bg-panel px-2.5 py-1.5 opacity-0 transition-all duration-100 group-hover:translate-x-0 group-hover:opacity-100"
        style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
        role="tooltip"
      >
        <span className="text-[12px] font-semibold text-text">{tip}</span>
        <span className="font-mono text-[9px] text-faint">{sub}</span>
      </span>
    </button>
  );
}
