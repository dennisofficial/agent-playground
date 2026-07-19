'use client';

import { Drawer } from '@/components/ui/drawer';
import { TopBar } from '@/features/shell/components/top-bar';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useOrg, useOrgs, type OrgSummary } from '@/lib/api/me';
import { cn } from '@/lib/cn';
import { SITE_MAP, type SettingsSection } from '@/lib/site-map';
import { orgSwatch, roleLabel } from '@/utils/org-display';
import {
  Check,
  ChevronDown,
  FolderCog,
  GitBranch,
  KeyRound,
  Layers,
  Plug,
  Settings as SettingsIcon,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { use, useEffect, useRef, useState, type ReactNode } from 'react';

const NAV: { id: SettingsSection; label: string; icon: typeof SettingsIcon }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'automation', label: 'Automation', icon: Zap },
  { id: 'credentials', label: 'Credentials', icon: KeyRound },
  { id: 'workspace-profile', label: 'Workspace profile', icon: FolderCog },
  { id: 'mcp-servers', label: 'MCP servers', icon: Plug },
  { id: 'convention-profiles', label: 'Convention profiles', icon: Layers },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'repos', label: 'Repos', icon: GitBranch },
];

const NAV_IDS = new Set<SettingsSection>(NAV.map((n) => n.id));

/** The active section is the last path segment (`…/settings/<section>`); the bare path falls back. */
function sectionFromPath(pathname: string): SettingsSection {
  const last = pathname.split('/').pop() ?? '';
  return NAV_IDS.has(last as SettingsSection) ? (last as SettingsSection) : 'general';
}

/**
 * Settings shell — a shared App Router layout that renders the app-wide top bar (the same `TopBar` as the
 * job workspace) + the settings section nav ONCE and persists it across per-section navigation; only the
 * routed `{children}` (the section page) swaps. The org switcher lives in the nav header (not the top bar),
 * so hopping between orgs' settings stays next to the section list. Resolves the targeted org by id from
 * the session, and owns the shared loading / not-found states so each leaf page can assume the org exists.
 */
export default function OrgSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { orgs, isLoading } = useOrgs();
  const org = useOrg(orgId);
  const router = useRouter();
  const pathname = usePathname();
  const section = sectionFromPath(pathname);
  const [navOpen, setNavOpen] = useState(false);
  const { isMobile } = useBreakpoint();

  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  const switchOrg = (id: string) => {
    if (id !== orgId) router.push(SITE_MAP.orgs.org(id).settings.section(section)());
  };

  return (
    <>
      <TopBar onOpenSidebar={() => setNavOpen(true)} />

      <div className="flex min-h-0 flex-1">
        {isMobile ? (
          <Drawer
            side="left"
            open={navOpen}
            onClose={() => setNavOpen(false)}
            label="Settings navigation"
          >
            <OrgSettingsNav
              inDrawer
              orgId={orgId}
              org={org}
              orgs={orgs}
              section={section}
              onSwitchOrg={switchOrg}
              setNavOpen={setNavOpen}
            />
          </Drawer>
        ) : (
          <OrgSettingsNav
            orgId={orgId}
            org={org}
            orgs={orgs}
            section={section}
            onSwitchOrg={switchOrg}
            setNavOpen={setNavOpen}
          />
        )}

        <div className="min-w-0 flex-1 overflow-y-auto bg-surface">
          <div className="max-w-160 px-4 py-8 pb-16 sm:px-9">
            {isLoading ? (
              <p className="text-[13px] text-faint">Loading…</p>
            ) : !org ? (
              <div className="rounded-lg border border-dashed border-border-2 px-6 py-14 text-center">
                <h2 className="text-[15px] font-semibold text-text">Organization not found</h2>
                <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-dim">
                  This organization doesn’t exist or you don’t have access to it.
                </p>
                <Link
                  href={SITE_MAP.workspace()}
                  className="mt-4 inline-block text-[12.5px] font-medium text-accent"
                >
                  ← Back to workspace
                </Link>
              </div>
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** The settings section nav — rendered inline (desktop) or inside the mobile drawer (`inDrawer`). Its
 *  header is the org switcher: the current org plus a dropdown to hop to any other org's settings. */
function OrgSettingsNav({
  inDrawer,
  orgId,
  org,
  orgs,
  section,
  onSwitchOrg,
  setNavOpen,
}: {
  inDrawer?: boolean;
  orgId: string;
  org: OrgSummary | undefined;
  orgs: OrgSummary[];
  section: SettingsSection;
  onSwitchOrg: (orgId: string) => void;
  setNavOpen: (open: boolean) => void;
}) {
  return (
    <nav
      className={cn(
        'flex flex-col gap-0.5 px-3 py-4',
        inDrawer ? 'w-full' : 'w-57 shrink-0 border-r border-border',
      )}
      style={{
        background: 'color-mix(in srgb, var(--panel) 60%, transparent)',
      }}
    >
      <div className="px-1 pb-3 pt-0.5">
        <OrgSwitcher
          orgs={orgs}
          currentId={orgId}
          org={org}
          onSwitch={(id) => {
            setNavOpen(false);
            onSwitchOrg(id);
          }}
        />
      </div>
      <div className="px-2 pb-1.5 pt-1 font-mono text-[9px] tracking-[0.16em] text-faint">
        ORGANIZATION
      </div>
      {NAV.map(({ id, label, icon: Icon }) => {
        const on = section === id;
        return (
          <Link
            key={id}
            href={SITE_MAP.orgs.org(orgId).settings.section(id)()}
            onClick={() => setNavOpen(false)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition',
              on ? 'text-accent' : 'text-dim hover:bg-surface-2',
            )}
            style={
              on
                ? {
                    background: 'var(--accent-soft)',
                    boxShadow: 'inset 0 0 0 1px var(--accent-line)',
                  }
                : undefined
            }
          >
            <Icon size={15} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Org switcher — the nav header. Shows the current org (swatch + name + status) as a full-width trigger and
 * drops down a list of every org the operator belongs to; selecting one navigates to that org's settings
 * preserving the active section. Replaces the former top-bar breadcrumb switcher.
 */
function OrgSwitcher({
  orgs,
  currentId,
  org,
  onSwitch,
}: {
  orgs: OrgSummary[];
  currentId: string;
  org: OrgSummary | undefined;
  onSwitch: (orgId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition"
        style={
          open
            ? {
                background: 'var(--accent-soft)',
                borderColor: 'var(--accent-line)',
              }
            : { background: 'var(--surface)', borderColor: 'var(--border)' }
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ background: org ? orgSwatch() : 'var(--faint)' }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-text">
            {org?.name ?? 'Organization'}
          </span>
          <span
            className="block font-mono text-[8.5px]"
            style={{
              color: org?.status === 'active' ? 'var(--green)' : 'var(--faint)',
            }}
          >
            {org?.status ?? '—'}
          </span>
        </span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 transition', open ? 'text-accent' : 'text-faint')}
          style={open ? { transform: 'rotate(180deg)' } : undefined}
        />
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          <div className="px-3 pb-1 pt-1.5 font-mono text-[8.5px] tracking-[0.12em] text-faint">
            SWITCH ORG SETTINGS
          </div>
          {orgs.map((o) => {
            const on = o.id === currentId;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSwitch(o.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition',
                  on ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span
                  className="h-2.25 w-2.25 shrink-0 rounded-xs"
                  style={{ background: orgSwatch() }}
                />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    className={cn(
                      'truncate text-[12px] text-text',
                      on ? 'font-semibold' : 'font-medium',
                    )}
                  >
                    {o.name}
                  </span>
                  <span className="font-mono text-[9px] text-faint">
                    {roleLabel(o.role)} · {o.status}
                  </span>
                </span>
                {on ? <Check size={13} className="shrink-0 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
