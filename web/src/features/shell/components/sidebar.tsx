'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ChevronRight, LayoutGrid, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES, threadHref } from '@/lib/routes';
import { useOrgs, type OrgSummary } from '@/lib/api/me';
import { useAllThreads, groupThreadsByOrgAndRepo, type OrgRepoGroup, type InboxThread } from '@/lib/api/inbox';
import { useThreadStatuses } from '@/lib/api/thread-status';
import type { ThreadStatusEntry } from '@/lib/api/thread-status';
import { StatusPie } from '@/components/ui/badges';
import { AccountMenu } from './account-menu';

/**
 * The single sidebar (240px) — the home for all navigation (design "Atlas Workspace Multi-Org"). A
 * greeting/account header, a Dashboard link, then one collapsible card per org nesting repo → thread, and
 * a New thread footer. Every org the operator belongs to is shown (no filtering / switching); orgs with no
 * threads in flight render a header-only card so a freshly-created org stays reachable. The active row +
 * "needs you" dot come from the shared status seam (`thread-status.ts`; today only the open thread).
 */
export function Sidebar() {
  const pathname = usePathname();
  const { owned, joined, isLoading: orgsLoading } = useOrgs();
  const { data: threads = [], isLoading: threadsLoading } = useAllThreads();
  const statuses = useThreadStatuses();

  // Owned-first, then joined — a stable order independent of thread recency.
  const orgs = useMemo(() => [...owned, ...joined], [owned, joined]);
  const orgOrder = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const groupByOrg = useMemo(() => {
    const map = new Map<string, OrgRepoGroup>();
    for (const g of groupThreadsByOrgAndRepo(threads, orgOrder)) map.set(g.orgId, g);
    return map;
  }, [threads, orgOrder]);

  const [collapsedOrgs, setCollapsedOrgs] = useState<Record<string, boolean>>({});
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const toggleOrg = (id: string) => setCollapsedOrgs((c) => ({ ...c, [id]: !c[id] }));
  const toggleRepo = (key: string) => setCollapsedRepos((c) => ({ ...c, [key]: !c[key] }));

  const onDashboard = pathname === ROUTES.workspace();

  return (
    <aside
      className="flex w-60 shrink-0 flex-col border-r border-border"
      style={{ background: 'var(--surface-2)' }}
    >
      <div className="px-3.5 pb-2.5 pt-3.5">
        <AccountMenu variant="sidebar" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        <Link
          href={ROUTES.workspace()}
          className={cn(
            'flex items-center gap-2.5 rounded-lg border px-3 py-2.5 transition',
            onDashboard ? 'border-accent-line' : 'border-border hover:brightness-[0.99]',
          )}
          style={{
            background: onDashboard ? 'var(--accent-soft)' : 'var(--surface)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
          }}
        >
          <LayoutGrid size={14} className={onDashboard ? 'text-accent' : 'text-dim'} />
          <span className={cn('flex-1 text-[12.5px] font-semibold', onDashboard ? 'text-accent' : 'text-text')}>
            Dashboard
          </span>
          <span className="font-mono text-[9px] text-faint">{threads.length}</span>
        </Link>

        {orgsLoading ? (
          <p className="px-2 py-3 text-[12px] text-faint">Loading…</p>
        ) : orgs.length === 0 ? (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-faint">
            No organizations yet. Create one from the account menu above.
          </p>
        ) : (
          orgs.map((org) => (
            <OrgCard
              key={org.id}
              org={org}
              group={groupByOrg.get(org.id)}
              collapsed={!!collapsedOrgs[org.id]}
              onToggle={() => toggleOrg(org.id)}
              collapsedRepos={collapsedRepos}
              onToggleRepo={toggleRepo}
              pathname={pathname}
              statuses={statuses}
              loading={threadsLoading}
            />
          ))
        )}
      </div>

      <div className="px-3 py-2.5">
        <Link
          href={ROUTES.newThread()}
          className="flex h-[34px] w-full items-center justify-center gap-2 rounded-md border text-[12.5px] font-semibold text-accent transition hover:brightness-105"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          <Plus size={15} /> New thread
        </Link>
      </div>
    </aside>
  );
}

/** One org card: a header (toggle · hover-gear → settings) over its repo → thread tree, or an empty note. */
function OrgCard({
  org,
  group,
  collapsed,
  onToggle,
  collapsedRepos,
  onToggleRepo,
  pathname,
  statuses,
  loading,
}: {
  org: OrgSummary;
  group: OrgRepoGroup | undefined;
  collapsed: boolean;
  onToggle: () => void;
  collapsedRepos: Record<string, boolean>;
  onToggleRepo: (key: string) => void;
  pathname: string;
  statuses: ReadonlyMap<string, ThreadStatusEntry>;
  loading: boolean;
}) {
  const repos = group?.repos ?? [];
  const expanded = !collapsed;

  return (
    <div
      className="mt-2.5 rounded-lg border border-border bg-surface px-2.5 pb-2 pt-1.5"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}
    >
      {/* header row: name-toggle + hover gear + chevron-toggle — three siblings, no nesting */}
      <div
        className={cn(
          'group/org flex items-center gap-1.5 px-0.5',
          expanded ? 'mb-1.5 border-b border-hair pb-2' : 'pb-0.5',
        )}
      >
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left" aria-label={`Toggle ${org.name}`}>
          <span className="block truncate text-[11px] font-bold tracking-[0.01em] text-text">{org.name}</span>
        </button>
        <Link
          href={ROUTES.orgSettings(org.id)}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-faint opacity-0 transition hover:text-accent group-hover/org:opacity-100"
          aria-label={`${org.name} settings`}
          title="Organization settings"
        >
          <Settings size={12} />
        </Link>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 text-faint"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronRight size={11} strokeWidth={2.5} className={cn('transition-transform', expanded && 'rotate-90')} />
        </button>
      </div>

      {expanded ? (
        repos.length === 0 ? (
          <div className="px-1 py-1 font-mono text-[10px] text-faint">
            {loading ? 'Loading…' : 'No active threads'}
          </div>
        ) : (
          repos.map((repo, i) => {
            const key = `${org.id}:${repo.repoId}`;
            return (
              <RepoGroup
                key={repo.repoId}
                orgId={org.id}
                repo={repo}
                last={i === repos.length - 1}
                collapsed={!!collapsedRepos[key]}
                onToggle={() => onToggleRepo(key)}
                pathname={pathname}
                statuses={statuses}
              />
            );
          })
        )
      ) : null}
    </div>
  );
}

/** A repo subgroup: a collapsible header over its in-flight thread rows. */
function RepoGroup({
  orgId,
  repo,
  last,
  collapsed,
  onToggle,
  pathname,
  statuses,
}: {
  orgId: string;
  repo: OrgRepoGroup['repos'][number];
  last: boolean;
  collapsed: boolean;
  onToggle: () => void;
  pathname: string;
  statuses: ReadonlyMap<string, ThreadStatusEntry>;
}) {
  const expanded = !collapsed;
  return (
    <div className={cn('mb-1 pb-1', !last && 'border-b border-hair')}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-0.5 py-1 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold text-text">{repo.repoName}</span>
        <ChevronRight size={10} strokeWidth={3} className={cn('shrink-0 text-faint transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded
        ? repo.threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              orgId={orgId}
              status={statuses.get(t.id)}
              active={pathname === threadHref({ orgId, repoId: repo.repoId, threadId: t.id })}
            />
          ))
        : null}
    </div>
  );
}

/** A thread row — opens the workspace. Status pie + title + an accent dot when it needs you. */
function ThreadRow({
  thread,
  orgId,
  status,
  active,
}: {
  thread: InboxThread;
  orgId: string;
  status?: ThreadStatusEntry;
  active: boolean;
}) {
  return (
    <Link
      href={threadHref({ orgId, repoId: thread.repo.id, threadId: thread.id })}
      title={`${thread.org.name} · ${thread.repo.name}`}
      className={cn('flex items-center gap-2 rounded-md py-1.5 pl-0.5 pr-1.5 transition', !active && 'hover:bg-surface-2')}
      style={active ? { background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' } : undefined}
    >
      <StatusPie status={status?.status} size={14} />
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">{thread.title}</span>
      {status?.needsYou ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} aria-hidden />
      ) : null}
    </Link>
  );
}
