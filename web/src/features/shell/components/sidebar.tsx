'use client';

import { CiStatusDot, PrStatusIcon, StatusPie } from '@/components/ui/badges';
import { useAllJobs, useArchivedJobs, type InboxThread } from '@/lib/api/inbox';
import { useAllRepos } from '@/lib/api/job-queries';
import { groupThreadsBySection, SECTION_LABEL, type JobSection } from '@/lib/api/job-section';
import { useOrgs, type OrgSummary } from '@/lib/api/me';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { ROUTES, threadHref } from '@/lib/routes';
import { ChevronRight, Globe, LayoutGrid, Plus, Server, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

/**
 * The workspace sidebar (272px) — a strict three-tier tree: ORGANIZATION (centered uppercase divider) →
 * repo (bold mono "folder") → thread (light, wrapping leaf). Redesign of the prior 240px card-based
 * sidebar per the "Atlas Workspace Multi-Org" handoff: flat hairline sections (no cards) and reclaimed
 * vertical space.
 *
 * **Active-first at scale.** Every org you belong to is shown (`useOrgs`), but idleness is tucked away at
 * both levels (an operator can have ~20 connected repos across several orgs):
 *   - A repo with threads is shown directly; the long tail of connected-but-idle repos in an active org
 *     rolls up under a single per-org "▸ N more repos" disclosure, opened on demand.
 *   - An org with NO active threads in any repo collapses to just its divider line by default — quiet
 *     until you open it, at which point its (idle) repos show directly. This keeps a fully-idle org with
 *     many repos to one line instead of dumping all of them.
 * (This replaces the handoff's per-item hide/show, which didn't scale: muting 18 of 20 repos left a
 * permanent "N hidden" line.) Explicit collapse/expand always overrides these data-driven defaults.
 *
 * Threads come from the cross-org inbox (`useAllJobs`), kept live by the realtime feed; each row's
 * `status` (the status pie) and `needsYou` (the accent attention dot) are server-owned. A collapsed
 * org/repo header carries an attention dot when any thread inside needs you (the rollup); expanded headers
 * show the per-thread dots instead.
 */

const repoKeyOf = (orgId: string, repoId: string) => `${orgId}:${repoId}`;

// Section collapse is global (collapsing "Merged" collapses it in every repo) and persists across
// reloads; the repo/org collapse above it does not. Default: everything expanded except Archived.
const COLLAPSED_SECTIONS_KEY = 'atlas.sidebar.collapsedSections';
const DEFAULT_COLLAPSED_SECTIONS: JobSection[] = ['archived'];

function loadCollapsedSections(): Set<JobSection> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_KEY);
    if (!raw) return new Set(DEFAULT_COLLAPSED_SECTIONS);
    return new Set(JSON.parse(raw) as JobSection[]);
  } catch {
    return new Set(DEFAULT_COLLAPSED_SECTIONS);
  }
}

/** The per-repo view-model the tree renders. */
interface RepoVM {
  repoId: string;
  repoName: string;
  key: string;
  threads: InboxThread[];
  noThreads: boolean;
  anyAct: boolean;
  collapsed: boolean;
  expanded: boolean;
  /** Attention dot on the collapsed header (rolled up from its threads). */
  rollupAct: boolean;
}

/** The per-org view-model. */
interface OrgVM {
  org: OrgSummary;
  activeRepos: RepoVM[];
  idleRepos: RepoVM[];
  idleCount: number;
  idleExpanded: boolean;
  noRepos: boolean;
  collapsed: boolean;
  visible: boolean;
  rollupAct: boolean;
}

export function Sidebar({ inDrawer = false }: { inDrawer?: boolean } = {}) {
  const pathname = usePathname();
  const { owned, joined, isLoading: orgsLoading } = useOrgs();
  const { repos: allRepos, isLoading: reposLoading } = useAllRepos();
  const { data: threads = [], isLoading: threadsLoading } = useAllJobs();

  // Owned-first, then joined — a stable order independent of thread recency.
  const orgs = useMemo(() => [...owned, ...joined], [owned, joined]);

  // Every connected repo grouped under its org, first-seen order (matches the create-job picker order).
  // Any repo referenced by a thread but absent from the connected list (a just-connected repo not yet in
  // cache, or a transient id mismatch) is appended so a thread never silently vanishes from the tree.
  const reposByOrg = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    const seen = new Set<string>();
    for (const o of orgs) map.set(o.id, []);
    const ensure = (orgId: string, id: string, name: string) => {
      const k = repoKeyOf(orgId, id);
      if (seen.has(k)) return;
      seen.add(k);
      const entry = { id, name };
      const list = map.get(orgId);
      if (list) list.push(entry);
      else map.set(orgId, [entry]);
    };
    for (const { orgId, repo } of allRepos) ensure(orgId, repo.id, repo.name);
    for (const t of threads) ensure(t.org.id, t.repo.id, t.repo.name);
    return map;
  }, [orgs, allRepos, threads]);

  // Threads keyed by `orgId:repoId`.
  const threadsByRepo = useMemo(() => {
    const map = new Map<string, InboxThread[]>();
    for (const t of threads) {
      const k = repoKeyOf(t.org.id, t.repo.id);
      const list = map.get(k);
      if (list) list.push(t);
      else map.set(k, [t]);
    }
    return map;
  }, [threads]);

  const [collapsedOrgs, setCollapsedOrgs] = useState<Record<string, boolean>>({});
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  // Per-org idle-repos disclosure. Undefined = use the default (expanded only when no active repos).
  const [idleOpen, setIdleOpen] = useState<Record<string, boolean>>({});

  // Seeded with the SSR-safe default, then hydrated from localStorage on mount (avoids a hydration
  // mismatch — the server never knows the browser's stored collapse state).
  const [collapsedSections, setCollapsedSections] = useState<Set<JobSection>>(
    () => new Set(DEFAULT_COLLAPSED_SECTIONS),
  );
  useEffect(() => {
    setCollapsedSections(loadCollapsedSections());
  }, []);

  const toggleRepo = (key: string) => setCollapsedRepos((c) => ({ ...c, [key]: !c[key] }));

  const isSectionCollapsed = (section: JobSection) => collapsedSections.has(section);

  const archivedExpanded = !isSectionCollapsed('archived');
  const { data: archivedThreads = [], isLoading: archivedLoading } =
    useArchivedJobs(archivedExpanded);

  const toggleSection = (section: JobSection) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      window.localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]));
      return next;
    });

  const buildRepoVM = (orgId: string, repo: { id: string; name: string }): RepoVM => {
    const key = repoKeyOf(orgId, repo.id);
    const repoThreads = threadsByRepo.get(key) ?? [];
    const repoCollapsed = !!collapsedRepos[key];
    const anyAct = repoThreads.some((t) => t.needsYou);
    return {
      repoId: repo.id,
      repoName: repo.name,
      key,
      threads: repoThreads,
      noThreads: repoThreads.length === 0,
      anyAct,
      collapsed: repoCollapsed,
      expanded: !repoCollapsed,
      rollupAct: repoCollapsed && anyAct,
    };
  };

  // ── Build the tree view-model ───────────────────────────────────────────────────────────────────
  const sidebarOrgs: OrgVM[] = orgs.map((org): OrgVM => {
    const repoList = reposByOrg.get(org.id) ?? [];
    const vms = repoList.map((r) => buildRepoVM(org.id, r));
    const activeRepos = vms.filter((r) => !r.noThreads);
    const idleRepos = vms.filter((r) => r.noThreads);
    const orgHasThreads = activeRepos.length > 0;
    const noRepos = repoList.length === 0;
    // A fully-idle org that HAS repos collapses to its divider by default (quiet until opened). An org
    // with active work — or with no repos at all (so its "No repositories yet → Connect" prompt stays
    // visible) — is expanded. Explicit user toggle wins.
    const orgCollapsed = collapsedOrgs[org.id] ?? (!orgHasThreads && !noRepos);
    // The idle-repos disclosure (only meaningful in an org that also has active repos) defaults closed.
    const idleExpanded = idleOpen[org.id] ?? false;
    const orgAnyAct = activeRepos.some((r) => r.anyAct);
    return {
      org,
      activeRepos,
      idleRepos,
      idleCount: idleRepos.length,
      idleExpanded,
      noRepos,
      collapsed: orgCollapsed,
      visible: !orgCollapsed,
      rollupAct: orgCollapsed && orgAnyAct,
    };
  });

  const onDashboard = pathname === ROUTES.workspace();

  return (
    <aside
      data-testid="app-sidebar"
      className={cn(
        'flex h-full flex-col',
        inDrawer ? 'w-full' : 'w-[272px] shrink-0 border-r border-border',
      )}
      style={{ background: 'var(--surface-2)' }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-3 pt-3">
        {/* Dashboard — flat row, no card. */}
        <Link
          href={ROUTES.workspace()}
          className={cn(
            'flex items-center gap-2.5 rounded-[7px] px-[9px] py-2 transition',
            onDashboard ? 'bg-accent-soft' : 'hover:bg-surface-2',
          )}
        >
          <LayoutGrid size={14} className={onDashboard ? 'text-accent' : 'text-dim'} />
          <span
            className={cn(
              'flex-1 text-[12.5px] font-semibold',
              onDashboard ? 'text-accent' : 'text-text',
            )}
          >
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
          sidebarOrgs.map((vm) => (
            <OrgSection
              key={vm.org.id}
              vm={vm}
              pathname={pathname}
              reposLoading={reposLoading}
              threadsLoading={threadsLoading}
              onToggleOrg={() => setCollapsedOrgs((c) => ({ ...c, [vm.org.id]: !vm.collapsed }))}
              onToggleRepo={toggleRepo}
              onToggleIdle={() => setIdleOpen((m) => ({ ...m, [vm.org.id]: !vm.idleExpanded }))}
              isSectionCollapsed={isSectionCollapsed}
              onToggleSection={toggleSection}
            />
          ))
        )}

        {/* Archived — one flat, cross-org group at the very bottom, fetched only once expanded (archived
            jobs may span repos/orgs the operator hasn't opened, so they don't live inside any org/repo
            section above). */}
        <ArchivedSection
          threads={archivedThreads}
          loading={archivedLoading}
          pathname={pathname}
          collapsed={!archivedExpanded}
          onToggle={() => toggleSection('archived')}
        />
      </div>

      {/* Build tag — the running web bundle's git SHA, baked in at build time (falls back to "dev"
          locally). Lets prod be checked against the latest deploy at a glance. */}
      <div className="flex-none border-t border-border px-3 py-2">
        <span className="font-mono text-[10px] text-faint" title="Running web build">
          {env.NEXT_PUBLIC_GIT_SHA}
        </span>
      </div>
    </aside>
  );
}

/** One org section: a centered-divider header over its active repos + an idle-repos disclosure. */
function OrgSection({
  vm,
  pathname,
  reposLoading,
  threadsLoading,
  onToggleOrg,
  onToggleRepo,
  onToggleIdle,
  isSectionCollapsed,
  onToggleSection,
}: {
  vm: OrgVM;
  pathname: string;
  reposLoading: boolean;
  threadsLoading: boolean;
  onToggleOrg: () => void;
  onToggleRepo: (key: string) => void;
  onToggleIdle: () => void;
  isSectionCollapsed: (section: JobSection) => boolean;
  onToggleSection: (section: JobSection) => void;
}) {
  const { org, collapsed } = vm;
  const expanded = !collapsed;
  const iconBtn = 'grid h-[18px] w-[18px] flex-none place-items-center rounded-[4px] transition';

  return (
    // Separation lives in symmetric padding (pt = pb + the parent's gap-0.5), NOT a top margin — so a
    // COLLAPSED org's label sits centered between its hairline and the next, instead of bottom-heavy.
    <div className="border-t border-border px-0.5 pb-2 pt-2.5">
      {/* Org header — the whole row toggles collapse; the absolute icon cluster keeps the title centered.
          No hairline under it: dividers separate siblings (repo↔repo, org↔org), never header↔content. */}
      <div className={cn('group/org relative', expanded ? 'mb-[5px] pb-[5px]' : '')}>
        <button
          type="button"
          onClick={onToggleOrg}
          className="flex w-full items-center justify-center px-0.5 py-1"
          aria-label={`Toggle ${org.name}`}
        >
          <span className="max-w-[78%] truncate text-center text-[10px] font-bold uppercase tracking-[0.07em] text-muted">
            {org.name}
          </span>
        </button>

        <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          <Link
            href={ROUTES.newThread({ orgId: org.id })}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              iconBtn,
              'text-faint opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover/org:opacity-[0.85] focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
            )}
            title="New job in this org"
            aria-label={`New job in ${org.name}`}
          >
            <Plus size={13} strokeWidth={2.4} />
          </Link>

          <Link
            href={ROUTES.orgSettings(org.id)}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              iconBtn,
              'text-faint opacity-0 transition-opacity hover:bg-surface-3 hover:text-text group-hover/org:opacity-90 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
            )}
            title="Org settings"
            aria-label={`${org.name} settings`}
          >
            <Settings size={12} strokeWidth={1.9} />
          </Link>

          {collapsed && vm.rollupAct ? (
            <span
              className="h-1.5 w-1.5 flex-none rounded-full"
              style={{ background: 'var(--accent)' }}
              title="Jobs need your attention"
              aria-hidden
            />
          ) : null}

          <button
            type="button"
            onClick={onToggleOrg}
            className="flex-none text-faint"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <ChevronRight
              size={11}
              strokeWidth={2.5}
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
          </button>
        </div>
      </div>

      {vm.visible ? (
        <>
          {vm.noRepos ? (
            reposLoading ? (
              <div className="px-1 py-1 font-mono text-[10px] text-faint">Loading…</div>
            ) : (
              <div className="flex items-center gap-[7px] px-1 pb-[3px] pt-[5px]">
                <span className="flex-1 text-[10.5px] italic text-faint">No repositories yet</span>
                <Link
                  href={ROUTES.orgSettings(org.id, 'repos')}
                  className="flex-none font-mono text-[9.5px] font-semibold text-accent"
                >
                  Connect ↗
                </Link>
              </div>
            )
          ) : null}

          {vm.activeRepos.length > 0 ? (
            <>
              {vm.activeRepos.map((repo, i) => (
                <RepoGroup
                  key={repo.key}
                  orgId={org.id}
                  repo={repo}
                  threadsLoading={threadsLoading}
                  pathname={pathname}
                  onToggle={() => onToggleRepo(repo.key)}
                  divided={i > 0}
                  isSectionCollapsed={isSectionCollapsed}
                  onToggleSection={onToggleSection}
                />
              ))}

              {/* Idle repos in an active org roll up under a disclosure (default closed). The disclosure
                  divides from the active repos above it; its revealed repos hang under it without a line. */}
              {vm.idleCount > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={onToggleIdle}
                    className="mt-[3px] flex w-full items-center gap-1.5 border-t border-hair rounded-[4px] px-1 pb-1 pt-[7px] text-left text-[10.5px] text-faint transition hover:text-dim"
                    aria-expanded={vm.idleExpanded}
                  >
                    <ChevronRight
                      size={9}
                      strokeWidth={3}
                      className={cn(
                        'flex-none transition-transform',
                        vm.idleExpanded && 'rotate-90',
                      )}
                    />
                    <span>
                      {vm.idleCount} more {vm.idleCount === 1 ? 'repo' : 'repos'}
                    </span>
                  </button>

                  {vm.idleExpanded
                    ? vm.idleRepos.map((repo, i) => (
                        <RepoGroup
                          key={repo.key}
                          orgId={org.id}
                          repo={repo}
                          threadsLoading={threadsLoading}
                          pathname={pathname}
                          onToggle={() => onToggleRepo(repo.key)}
                          divided={i > 0}
                          isSectionCollapsed={isSectionCollapsed}
                          onToggleSection={onToggleSection}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </>
          ) : (
            /* Fully-idle org: it's only visible because it was expanded, so list its repos directly. */
            vm.idleRepos.map((repo, i) => (
              <RepoGroup
                key={repo.key}
                orgId={org.id}
                repo={repo}
                threadsLoading={threadsLoading}
                pathname={pathname}
                onToggle={() => onToggleRepo(repo.key)}
                divided={i > 0}
                isSectionCollapsed={isSectionCollapsed}
                onToggleSection={onToggleSection}
              />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

/** A repo subgroup: a bold-mono "folder" header over its thread leaves (or an empty "Start one ＋" row).
 * `divided` draws a top hairline — set only when this repo follows a sibling, so the line separates groups
 * rather than sitting under a header or trailing the list. */
function RepoGroup({
  orgId,
  repo,
  threadsLoading,
  pathname,
  onToggle,
  divided,
  isSectionCollapsed,
  onToggleSection,
}: {
  orgId: string;
  repo: RepoVM;
  threadsLoading: boolean;
  pathname: string;
  onToggle: () => void;
  divided: boolean;
  isSectionCollapsed: (section: JobSection) => boolean;
  onToggleSection: (section: JobSection) => void;
}) {
  const iconBtn = 'grid h-[18px] w-[18px] flex-none place-items-center rounded-[4px] transition';
  return (
    <div className={cn('pb-[3px]', divided && 'mt-[3px] border-t border-hair pt-[3px]')}>
      <div className="group/repo flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-[7px] rounded-[4px] px-[3px] pb-1 pt-[5px] text-left"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold tracking-[-0.01em] text-text">
            {repo.repoName}
          </span>
        </button>

        <Link
          href={ROUTES.newThread({ orgId, repoId: repo.repoId })}
          className={cn(
            iconBtn,
            'text-faint opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover/repo:opacity-90 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          )}
          title="New job in this repo"
          aria-label={`New job in ${repo.repoName}`}
        >
          <Plus size={13} strokeWidth={2.4} />
        </Link>

        {repo.rollupAct ? (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: 'var(--accent)' }}
            title="Jobs need your attention"
            aria-hidden
          />
        ) : null}

        <button
          type="button"
          onClick={onToggle}
          className="flex-none text-faint"
          aria-label="Toggle repo"
        >
          <ChevronRight
            size={10}
            strokeWidth={3}
            className={cn('transition-transform', repo.expanded && 'rotate-90')}
          />
        </button>
      </div>

      {repo.expanded ? (
        repo.noThreads ? (
          threadsLoading ? (
            <div className="px-1 py-0.5 font-mono text-[10px] text-faint">Loading…</div>
          ) : (
            <Link
              href={ROUTES.newThread({ orgId, repoId: repo.repoId })}
              className="flex items-center gap-[7px] rounded-[4px] pb-[5px] pl-1 pr-[7px] pt-1 transition hover:bg-surface-2"
            >
              <span className="flex-1 text-[10.5px] italic text-faint">No jobs yet</span>
              <span className="flex-none font-mono text-[9.5px] font-semibold text-accent">
                Start one ＋
              </span>
            </Link>
          )
        ) : (
          groupThreadsBySection(repo.threads).map(({ section, threads }) => (
            <SidebarSection
              key={section}
              section={section}
              count={threads.length}
              collapsed={isSectionCollapsed(section)}
              onToggle={() => onToggleSection(section)}
              anyNeedsYou={threads.some((t) => t.needsYou)}
            >
              {threads.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  orgId={orgId}
                  section={section}
                  active={pathname === threadHref({ orgId, repoId: repo.repoId, jobId: t.id })}
                />
              ))}
            </SidebarSection>
          ))
        )
      ) : null}
    </div>
  );
}

/** The flat, cross-org "Archived" group — a sibling of the per-org sections, not nested inside any of
 *  them (an archived job may belong to a repo/org the operator hasn't expanded). Always rendered so the
 *  operator has something to expand; its jobs are fetched lazily, only once expanded. */
function ArchivedSection({
  threads,
  loading,
  pathname,
  collapsed,
  onToggle,
}: {
  threads: InboxThread[];
  loading: boolean;
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-t border-border px-0.5 pb-2 pt-2.5">
      <SidebarSection
        section="archived"
        count={threads.length}
        collapsed={collapsed}
        onToggle={onToggle}
        anyNeedsYou={false}
      >
        {loading ? (
          <div className="px-1 py-0.5 font-mono text-[10px] text-faint">Loading…</div>
        ) : threads.length === 0 ? (
          <div className="px-1 py-0.5 text-[10.5px] italic text-faint">No archived jobs</div>
        ) : (
          threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              orgId={t.org.id}
              section="archived"
              active={pathname === threadHref({ orgId: t.org.id, repoId: t.repo.id, jobId: t.id })}
            />
          ))
        )}
      </SidebarSection>
    </div>
  );
}

/** The fixed swatch/label color per {@link JobSection} (matches the sidebar-redesign mockup palette). */
const SECTION_COLOR: Record<JobSection, string> = {
  planning: 'var(--blue)',
  reviewing: 'var(--blue)',
  blocked: 'var(--amber)',
  awaiting: 'var(--slate)',
  building: 'var(--accent)',
  master_review: 'var(--blue)',
  amending: 'var(--amber)',
  ready_to_ship: 'var(--green)',
  done: 'var(--green)',
  pr_open: 'var(--green)',
  merged: 'var(--purple)',
  archived: 'var(--faint)',
};

/** A collapsible status-derived section header (label + live count + chevron) over its thread rows.
 *  Collapse state is owned by the caller (persisted globally per section, see `Sidebar`). */
function SidebarSection({
  section,
  count,
  collapsed,
  onToggle,
  anyNeedsYou,
  children,
}: {
  section: JobSection;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  anyNeedsYou: boolean;
  children: React.ReactNode;
}) {
  const color = SECTION_COLOR[section];
  return (
    <div className="pb-[3px]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-[7px] rounded-[4px] px-[3px] pb-[3px] pt-[7px] text-left"
        aria-expanded={!collapsed}
      >
        <span
          className="h-[7px] w-[7px] flex-none rounded-[2px]"
          style={{ background: color }}
          aria-hidden
        />
        <span
          className="font-mono text-[9.5px] font-bold uppercase tracking-[0.07em]"
          style={{ color }}
        >
          {SECTION_LABEL[section]}
        </span>
        <span className="rounded-full bg-surface-2 px-[5px] font-mono text-[9px] text-faint">
          {count}
        </span>
        {collapsed && anyNeedsYou ? (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: 'var(--accent)' }}
            title="Jobs need your attention"
            aria-hidden
          />
        ) : null}
        <ChevronRight
          size={9}
          strokeWidth={2.5}
          className={cn(
            'ml-auto flex-none text-faint transition-transform',
            !collapsed && 'rotate-90',
          )}
        />
      </button>
      {collapsed ? null : children}
    </div>
  );
}

/** A thread leaf — opens the workspace. Status pie + a 2-line wrapping title + an accent dot when it needs you. */
function ThreadRow({
  thread,
  orgId,
  section,
  active,
}: {
  thread: InboxThread;
  orgId: string;
  section: JobSection;
  active: boolean;
}) {
  const showBuildStages = section === 'building' && thread.buildStagesTotal != null;
  const hasTrailingMeta =
    thread.portState != null || thread.pr?.number != null || thread.needsYou || showBuildStages;
  return (
    <Link
      href={threadHref({ orgId, repoId: thread.repo.id, jobId: thread.id })}
      title={`${thread.org.name} · ${thread.repo.name}`}
      className={cn(
        'flex items-start gap-1.5 rounded-[7px] pb-[5px] pl-[3px] pr-[7px] pt-[5px] transition',
        !active && 'hover:bg-surface-2',
      )}
      style={
        active
          ? {
              background: 'var(--accent-soft)',
              outline: '1px solid var(--accent-line)',
              outlineOffset: '-1px',
            }
          : undefined
      }
    >
      <span className="relative mt-px flex-none">
        {/* A halted thread (an unresolved turn-stopping error) shows the failed ✕ over everything — it
            needs attention above its PR glyph. Otherwise, once a PR exists the leaf shows its PR status
            (GitHub color convention); until then, the build-lifecycle status pie. */}
        {thread.halted ? (
          <StatusPie status={thread.status} halted size={14} />
        ) : thread.pr ? (
          <PrStatusIcon pr={thread.pr} size={14} />
        ) : (
          <StatusPie status={thread.status} size={14} />
        )}
        {thread.halt ? (
          <span
            className="absolute -bottom-px -right-0.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-panel"
            style={{ background: 'var(--red)' }}
            title={`Halted — ${thread.halt.reason}`}
            aria-label="Halted"
          />
        ) : null}
        {thread.pr ? <CiStatusDot ci={thread.ci} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[12px] font-normal leading-[1.32] text-text">
          {thread.title}
        </span>
      </span>
      {hasTrailingMeta ? (
        <span className="flex h-[1.32em] flex-none items-center gap-1.5 text-[12px]">
          {thread.portState ? (
            <span
              className="flex-none"
              title={
                thread.portState === 'exposed'
                  ? 'Exposed port — reachable preview URL'
                  : 'Service running (not exposed)'
              }
              aria-label={
                thread.portState === 'exposed' ? 'Exposed port' : 'Service running, not exposed'
              }
            >
              {thread.portState === 'exposed' ? (
                <Globe size={11} style={{ color: 'var(--blue)' }} />
              ) : (
                <Server size={11} style={{ color: 'var(--faint)' }} />
              )}
            </span>
          ) : null}
          {thread.pr?.number != null ? (
            <span className="flex-none font-mono text-[10px] leading-none text-faint">
              #{thread.pr.number}
            </span>
          ) : null}
          {thread.needsYou ? (
            <span
              className="h-1.5 w-1.5 flex-none rounded-full"
              style={{ background: 'var(--accent)' }}
              aria-hidden
            />
          ) : showBuildStages ? (
            <span
              className="flex-none font-mono text-[10px] leading-none text-faint"
              title="Builder stages completed"
              aria-label={`${thread.buildStagesDone ?? 0} of ${thread.buildStagesTotal} builder stages completed`}
            >
              {thread.buildStagesDone ?? 0}/{thread.buildStagesTotal}
            </span>
          ) : null}
        </span>
      ) : null}
    </Link>
  );
}
