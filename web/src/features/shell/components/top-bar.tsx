'use client';

import { cn } from '@/lib/cn';
import { ROUTES } from '@/lib/routes';
import { Menu, Network, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AccountMenu } from './account-menu';
import { HostStats } from './host-stats';

/**
 * The app-wide top bar. Pure chrome: the ATLAS lockup, the primary Jobs nav item, host stats, and the
 * account menu (avatar trigger → signed-in-as · org settings · create org · theme · sign out). This is the
 * shared bar the settings shell reuses too, so the account dropdown lives here rather than in the sidebar.
 * Below the sidebar breakpoint (<768px) it also carries the hamburger that opens the off-canvas sidebar
 * drawer and — where a search target is wired — a ⌘K shortcut, since neither is reachable without a
 * pointer/keyboard there.
 */
export function TopBar({
  onOpenSidebar,
  onOpenSearch,
}: {
  onOpenSidebar?: () => void;
  onOpenSearch?: () => void;
}) {
  const pathname = usePathname();
  const onJobs = pathname.startsWith(ROUTES.workspace());

  return (
    <header
      className="relative z-30 flex h-[52px] flex-none items-center gap-2 border-b border-border px-3 md:gap-3.5 md:px-4"
      style={{
        background: 'color-mix(in srgb, var(--panel) 82%, transparent)',
        backdropFilter: 'blur(12px)',
      }}
    >
      <button
        type="button"
        onClick={() => onOpenSidebar?.()}
        className="grid h-9 w-9 flex-none -ml-1 place-items-center rounded-md text-dim transition hover:bg-surface-2 md:hidden"
        aria-label="Open navigation"
      >
        <Menu size={17} />
      </button>

      <Link href={ROUTES.workspace()} className="flex items-center gap-2.5" aria-label="Atlas home">
        <span
          className="grid h-7 w-7 flex-none place-items-center rounded-lg"
          style={{
            background: 'linear-gradient(145deg, var(--accent), var(--accent-2))',
            boxShadow: '0 2px 8px var(--accent-soft)',
          }}
        >
          <span
            className="h-[11px] w-[11px] rounded-[1.5px] border-[1.6px] border-white"
            style={{ transform: 'rotate(45deg)' }}
          />
        </span>
        <span className="hidden font-disp text-[14px] font-bold tracking-[0.16em] text-text sm:inline">
          ATLAS
        </span>
      </Link>

      <span className="hidden h-5 w-px md:block" style={{ background: 'var(--border)' }} />

      <nav className="flex h-full items-stretch gap-3.5 md:gap-[22px]">
        <TopNavItem
          href={ROUTES.workspace()}
          active={onJobs}
          icon={<Network size={13} />}
          label="Jobs"
        />
      </nav>

      <div className="flex-1" />

      {onOpenSearch ? (
        <button
          type="button"
          onClick={() => onOpenSearch()}
          className="grid h-9 w-9 flex-none place-items-center rounded-md text-dim transition hover:bg-surface-2 md:hidden"
          aria-label="Search jobs"
        >
          <Search size={16} />
        </button>
      ) : null}

      <HostStats />

      <AccountMenu />
    </header>
  );
}

function TopNavItem({
  href,
  active,
  icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex h-full items-center gap-[7px] border-b-2 px-1 text-[13px] font-semibold transition',
        active ? 'border-accent text-text' : 'border-transparent text-dim hover:text-text',
      )}
    >
      {icon}
      {label}
    </Link>
  );
}
