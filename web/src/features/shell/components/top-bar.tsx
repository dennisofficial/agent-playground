"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Network, Search, Ticket } from "lucide-react";
import { cn } from "@/lib/cn";
import { ROUTES } from "@/lib/routes";
import { useCurrentUser } from "@/lib/api/me";

/**
 * The app-wide top bar (design "Atlas Tickets Board"). Pure chrome: the ATLAS lockup, the primary
 * Threads | Tickets nav switch, and the operator avatar. It wraps BOTH the threads workspace and the
 * tickets board (mounted in `AppChrome`), so the nav is always available. Daylight-only (no theme toggle).
 * Below the sidebar breakpoint (<768px) it also carries the hamburger that opens the off-canvas sidebar
 * drawer and a search shortcut for ⌘K, since neither is reachable without a pointer/keyboard there.
 */
export function TopBar({
  onOpenSidebar,
  onOpenSearch,
}: {
  onOpenSidebar?: () => void;
  onOpenSearch?: () => void;
}) {
  const pathname = usePathname();
  const onTickets = pathname.startsWith("/tickets");
  const onThreads = !onTickets; // workspace, dashboard, new — everything else is the threads side

  return (
    <header
      className="flex h-[52px] flex-none items-center gap-2 border-b border-border px-3 md:gap-3.5 md:px-4"
      style={{
        background: "color-mix(in srgb, var(--panel) 82%, transparent)",
        backdropFilter: "blur(12px)",
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

      <Link
        href={ROUTES.workspace()}
        className="flex items-center gap-2.5"
        aria-label="Atlas home"
      >
        <span
          className="grid h-7 w-7 flex-none place-items-center rounded-lg"
          style={{
            background:
              "linear-gradient(145deg, var(--accent), var(--accent-2))",
            boxShadow: "0 2px 8px var(--accent-soft)",
          }}
        >
          <span
            className="h-[11px] w-[11px] rounded-[1.5px] border-[1.6px] border-white"
            style={{ transform: "rotate(45deg)" }}
          />
        </span>
        <span className="hidden font-disp text-[14px] font-bold tracking-[0.16em] text-text sm:inline">
          ATLAS
        </span>
      </Link>

      <span
        className="hidden h-5 w-px md:block"
        style={{ background: "var(--border)" }}
      />

      <nav className="flex h-full items-stretch gap-3.5 md:gap-[22px]">
        <TopNavItem
          href={ROUTES.workspace()}
          active={onThreads}
          icon={<Network size={13} />}
          label="Jobs"
        />
        <TopNavItem
          href={ROUTES.tickets()}
          active={onTickets}
          icon={<Ticket size={13} />}
          label="Tickets"
        />
      </nav>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => onOpenSearch?.()}
        className="grid h-9 w-9 flex-none place-items-center rounded-md text-dim transition hover:bg-surface-2 md:hidden"
        aria-label="Search jobs"
      >
        <Search size={16} />
      </button>

      <Avatar />
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
        "flex h-full items-center gap-[7px] border-b-2 px-1 text-[13px] font-semibold transition",
        active
          ? "border-accent text-text"
          : "border-transparent text-dim hover:text-text",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

function Avatar() {
  const { data: user } = useCurrentUser();
  const initials = avatarInitials(user?.name, user?.email);
  return (
    <span
      className="grid h-7 w-7 flex-none place-items-center rounded-full font-disp text-[11px] font-semibold text-white"
      style={{
        background: "linear-gradient(145deg, var(--accent), var(--accent-2))",
      }}
      title={user?.name ?? user?.email ?? "Account"}
    >
      {initials}
    </span>
  );
}

function avatarInitials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  if (!source) return "·";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}
