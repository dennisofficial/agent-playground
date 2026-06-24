'use client';

import { useMemo } from 'react';
import { Check } from 'lucide-react';
import { useOrgs } from '@/lib/api/me';
import { useAllThreads } from '@/lib/api/inbox';
import { useThreadStatuses } from '@/lib/api/thread-status';
import { NeedsYouBand } from '@/features/inbox/components/needs-you-band';

/**
 * Dashboard — the cross-org coordinator. The org-grouped board is gone (the sidebar is now the home for
 * all projects); this surfaces only what needs the operator, across every org. Cross-thread `needsYou` is
 * known only for the open thread today (`thread-status.ts`), so when nothing needs you it shows an
 * "all caught up" state rather than a blank page.
 */
export default function CoordinatorPage() {
  const { orgs, isLoading: orgsLoading } = useOrgs();
  const { data: threads = [], isLoading } = useAllThreads();
  const statuses = useThreadStatuses();
  const attention = useMemo(() => threads.filter((t) => statuses.get(t.id)?.needsYou), [threads, statuses]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-9 py-8">
        <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">All organizations</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-dim">
          Everything that needs you, across every organization. Browse all projects in the sidebar; jump
          into any thread to steer it.
        </p>

        {orgsLoading || isLoading ? (
          <p className="mt-10 text-[13px] text-faint">Loading…</p>
        ) : orgs.length === 0 ? (
          <EmptyBoard
            title="No organizations yet"
            body="Create an organization and connect a repo to start steering work — use the account menu in the sidebar."
          />
        ) : threads.length === 0 ? (
          <EmptyBoard
            title="No threads yet"
            body="None of your organizations have threads yet. Start one with “New thread” in the sidebar."
          />
        ) : attention.length > 0 ? (
          <div className="mt-7">
            <NeedsYouBand threads={threads} />
          </div>
        ) : (
          <AllCaughtUp />
        )}
      </div>
    </div>
  );
}

/** Shown when there are threads but none currently need the operator (the common case today). */
function AllCaughtUp() {
  return (
    <div
      className="mt-7 flex flex-col items-center rounded-lg border px-6 py-16 text-center"
      style={{ borderColor: 'var(--green-soft)', background: 'var(--green-soft)' }}
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full text-green"
        style={{ background: 'color-mix(in srgb, var(--green) 14%, transparent)' }}
      >
        <Check size={20} />
      </span>
      <h2 className="mt-3 text-[15px] font-semibold text-text">You&apos;re all caught up</h2>
      <p className="mt-1.5 max-w-md text-[13px] text-dim">
        Nothing needs your attention right now. Browse your projects in the sidebar, or start something new.
      </p>
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
