'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { LayoutGrid, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES, threadHref } from '@/lib/routes';
import { useOrgFilter } from '@/components/providers/orgs-provider';
import { useInbox, type InboxThread } from '@/lib/api/inbox';
import { useThreadStatuses } from '@/lib/api/thread-status';
import { orgColor, orgInitials, roleLabel } from '@/lib/org-display';
import { KIND_META } from '@/lib/api/status';
import { StatusDot } from '@/components/ui/badges';
import type { ThreadStatusEntry } from '@/lib/api/thread-status';

/**
 * Left sidebar (240px): New thread, Coordinator (the cross-org board), then threads grouped by org —
 * every org's threads in one list, never a switch. Rows open the thread workspace; the active row + any
 * live status dot / "NEEDS YOU" come from the shared status seam (today only the open thread; see
 * `thread-status.ts`).
 */
export function Sidebar() {
  const pathname = usePathname();
  const { filter, orgs } = useOrgFilter();
  const orgOrder = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const { threads, groups, isLoading } = useInbox(filter, orgOrder);
  const roleOf = useMemo(() => new Map(orgs.map((o) => [o.id, o.role])), [orgs]);
  const statuses = useThreadStatuses();

  const onOverview = pathname === ROUTES.workspace();
  // When a single org is selected, its name is already in the top-bar chip — skip per-group headers.
  const showHeaders = filter === 'all';

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r border-border"
      style={{ background: 'color-mix(in srgb, var(--panel) 60%, transparent)' }}
    >
      <div className="p-3">
        <Link
          href={ROUTES.newThread()}
          className="flex w-full items-center justify-center gap-2 rounded-md border py-2 text-[12.5px] font-medium text-accent transition hover:brightness-105"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          <Plus size={15} /> New thread
        </Link>
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
              {g.threads.map((t) => {
                const href = threadHref({ orgId: t.org.id, repoId: t.repo.id, threadId: t.id });
                return (
                  <ThreadRow
                    key={t.id}
                    thread={t}
                    href={href}
                    active={pathname === href}
                    status={statuses.get(t.id)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** A thread row — opens the workspace. Leading dot is the live status (if known) else the kind tint. */
function ThreadRow({
  thread,
  href,
  active,
  status,
}: {
  thread: InboxThread;
  href: string;
  active: boolean;
  status?: ThreadStatusEntry;
}) {
  return (
    <Link
      href={href}
      title={`${thread.org.name} · ${thread.repo.name}`}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-2 transition',
        active ? '' : 'hover:bg-surface-2',
        status?.needsYou && !active && 'border-l-[3px] pl-[5px]',
      )}
      style={
        active
          ? { background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }
          : status?.needsYou
            ? {
                background: 'color-mix(in srgb, var(--rose) 8%, transparent)',
                borderLeftColor: 'var(--rose)',
              }
            : undefined
      }
    >
      {status ? (
        <StatusDot status={status.status} size={7} />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: KIND_META[thread.kind].color }} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-text">{thread.title}</div>
      </div>
      {status?.needsYou ? (
        <span className="flex shrink-0 items-center gap-1 font-mono text-[8px] font-semibold text-rose">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--rose)' }} />
          NEEDS YOU
        </span>
      ) : (
        <span className="shrink-0 truncate font-mono text-[8.5px] uppercase tracking-wide text-faint">
          {thread.repo.name}
        </span>
      )}
    </Link>
  );
}
