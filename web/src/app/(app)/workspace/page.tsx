'use client';

import { useMemo } from 'react';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { useInbox } from '@/lib/api/inbox';
import { OrgBoard } from '@/features/inbox/components/org-board';
import { NeedsYouBand } from '@/features/inbox/components/needs-you-band';
import { roleLabel } from '@/lib/org-display';

/**
 * Coordinator — the "All organizations" board. Every thread across every org the operator belongs to, in
 * one place (the handoff north star: one login, many orgs, no switching). The org rail / top-bar chip
 * narrow it to a single org. Status / "needs you" are intentionally absent — the thread list carries no
 * such signal yet (see the plan's data-gaps note).
 */
export default function CoordinatorPage() {
  const { filter, orgs, isLoading: orgsLoading } = useOrgFilter();
  const orgOrder = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const roleOf = useMemo(() => new Map(orgs.map((o) => [o.id, o.role])), [orgs]);
  const { groups, threads, isLoading } = useInbox(filter, orgOrder);

  const selectedOrg = filter === 'all' ? null : orgs.find((o) => o.id === filter);
  const title = selectedOrg ? selectedOrg.name : 'All organizations';
  const subtitle = selectedOrg
    ? `Threads in ${selectedOrg.name} — ${roleLabel(selectedOrg.role)} · ${selectedOrg.status}.`
    : 'Every thread across your organizations — one board, no switching. Threads carry their org so you always know whose work you’re steering.';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-9 py-8">
        <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-dim">{subtitle}</p>

        {orgsLoading || isLoading ? (
          <p className="mt-10 text-[13px] text-faint">Loading…</p>
        ) : orgs.length === 0 ? (
          <EmptyBoard
            title="No organizations yet"
            body="Create an organization and connect a repo to start steering work. Onboarding lives in setup."
          />
        ) : threads.length === 0 ? (
          <EmptyBoard
            title="No threads yet"
            body={
              selectedOrg
                ? `${selectedOrg.name} has no threads yet.`
                : 'None of your organizations have threads yet. They’ll appear here, grouped by org, as work begins.'
            }
          />
        ) : (
          <div className="mt-7">
            <NeedsYouBand threads={threads} />
            <OrgBoard groups={groups} roleOf={roleOf} />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyBoard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-10 flex flex-col items-center rounded-lg border border-dashed border-border-2 px-6 py-16 text-center">
      <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      <p className="mt-1.5 max-w-md text-[13px] text-dim">{body}</p>
    </div>
  );
}
