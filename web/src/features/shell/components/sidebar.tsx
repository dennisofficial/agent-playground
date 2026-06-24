'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { LayoutGrid, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES } from '@/lib/routes';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { useInbox, type InboxThread } from '@/lib/api/inbox';
import { orgColor, orgInitials, roleLabel } from '@/lib/org-display';
import { KIND_META } from '@/lib/api/status';

/**
 * Left sidebar (240px): New thread (deferred), Coordinator (the cross-org board), then threads grouped by
 * org — every org's threads in one list, never a switch. Rows are read-only this phase (opening a thread
 * is the deferred follow-up).
 */
export function Sidebar() {
  const pathname = usePathname();
  const { filter, orgs } = useOrgFilter();
  const orgOrder = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const { threads, groups, isLoading } = useInbox(filter, orgOrder);
  const roleOf = useMemo(() => new Map(orgs.map((o) => [o.id, o.role])), [orgs]);

  const onOverview = pathname === ROUTES.workspace();
  // When a single org is selected, its name is already in the top-bar chip — skip per-group headers.
  const showHeaders = filter === 'all';

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r border-border"
      style={{ background: 'color-mix(in srgb, var(--panel) 60%, transparent)' }}
    >
      <div className="p-3">
        <button
          type="button"
          disabled
          title="Creating threads from the multi-org shell is coming soon"
          className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-md border py-2 text-[12.5px] font-medium text-accent opacity-60"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          <Plus size={15} /> New thread
          <span className="ml-1 rounded-full border border-accent-line px-1.5 py-px font-mono text-[8px] tracking-wide">
            soon
          </span>
        </button>
      </div>

      <nav className="px-3 pb-1">
        <Link
          href={ROUTES.workspace()}
          className={cn(
            'flex items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition',
            onOverview ? 'text-text' : 'text-dim hover:bg-surface-2',
          )}
          style={onOverview ? { background: 'var(--surface-2)' } : undefined}
        >
          <LayoutGrid size={14} className="text-faint" />
          <span className="flex-1">Coordinator</span>
          <span className="font-mono text-[10px] text-faint">{threads.length}</span>
        </Link>
      </nav>

      <div className="flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {isLoading ? (
          <p className="px-2 py-3 text-[12px] text-faint">Loading threads…</p>
        ) : threads.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-faint">
            No threads yet across your organizations.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.orgId} className="mb-2 flex flex-col gap-0.5">
              {showHeaders ? (
                <div className="flex items-center gap-2 px-1 pb-1 pt-2">
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded font-disp text-[8px] font-semibold text-white"
                    style={{ background: orgColor(g.orgId) }}
                  >
                    {orgInitials(g.orgName)}
                  </span>
                  <span className="flex-1 truncate text-[10px] font-semibold text-dim">{g.orgName}</span>
                  <span className="font-mono text-[8px] text-faint">{roleLabel(roleOf.get(g.orgId) ?? 'member')}</span>
                </div>
              ) : null}
              {g.threads.map((t) => (
                <ThreadRow key={t.id} thread={t} />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** Read-only thread row (opening a thread is deferred). Kind-colored dot + title + repo. */
function ThreadRow({ thread }: { thread: InboxThread }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-2" title={`${thread.org.name} · ${thread.repo.name}`}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: KIND_META[thread.kind].color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-text">{thread.title}</div>
      </div>
      <span className="shrink-0 truncate font-mono text-[8.5px] uppercase tracking-wide text-faint">
        {thread.repo.name}
      </span>
    </div>
  );
}
