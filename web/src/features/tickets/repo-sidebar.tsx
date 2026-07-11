"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { ROUTES } from "@/lib/routes";
import { useCurrentUser } from "@/lib/api/me";
import { useAllRepos } from "@/lib/api/tickets-queries";
import { useBreakpoint } from "@/lib/use-breakpoint";
import { Drawer } from "@/components/ui/drawer";
import { useLeftNav } from "@/features/shell/left-nav";

const REPO_PALETTE = [
  "var(--accent)",
  "var(--blue)",
  "var(--green)",
  "var(--purple)",
  "var(--red)",
];

/** Stable color per repo (visual variety in the list), hashed from the repo id. */
function repoColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return REPO_PALETTE[h % REPO_PALETTE.length];
}

/**
 * The tickets repo picker (236px). One row per connected repo across every org; selecting one routes to
 * its board. Replaces the threads org→repo→thread sidebar while on the tickets side (the top bar's
 * Threads | Tickets switch returns to the threads workspace).
 */
export function RepoSidebar() {
  const { isMobile } = useBreakpoint();
  const { open, setOpen } = useLeftNav();

  if (isMobile) {
    return (
      <Drawer
        side="left"
        open={open}
        onClose={() => setOpen(false)}
        label="Repositories"
      >
        <RepoSidebarInner inDrawer />
      </Drawer>
    );
  }
  return <RepoSidebarInner />;
}

function RepoSidebarInner({ inDrawer }: { inDrawer?: boolean }) {
  const pathname = usePathname();
  // `/tickets/{orgId}/{repoId}` → the selected repo (highlight).
  const activeRepoId = pathname.startsWith("/tickets/")
    ? pathname.split("/")[3]
    : undefined;
  const { data: user } = useCurrentUser();
  const { repos, isLoading } = useAllRepos();
  const firstName = (user?.name ?? user?.email ?? "there").split(/[\s@]/)[0];

  return (
    <aside
      className={cn(
        "flex flex-col",
        inDrawer ? "w-full" : "w-[236px] flex-none border-r border-border",
      )}
      style={{ background: "var(--surface-2)" }}
    >
      <div className="flex-none px-[15px] pb-2 pt-[15px]">
        <div className="font-disp text-[13.5px] font-semibold tracking-tight text-text">
          What&apos;s next, {firstName}?
        </div>
        <div className="mt-[3px] text-[11px] text-dim">
          Pick a repo to see its board.
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-2 pb-3">
        <div className="px-2 pb-[5px] pt-2 font-mono text-[9px] tracking-[0.16em] text-faint">
          REPOSITORIES
        </div>
        {isLoading ? (
          <p className="px-2 py-3 text-[12px] text-faint">Loading…</p>
        ) : repos.length === 0 ? (
          <p className="px-2 py-3 text-[11.5px] leading-relaxed text-faint">
            No repos connected yet. Connect one from an org&apos;s settings to
            get a board.
          </p>
        ) : (
          repos.map(({ orgId, orgName, repo }) => {
            const active = repo.id === activeRepoId;
            return (
              <Link
                key={`${orgId}:${repo.id}`}
                href={ROUTES.tickets(orgId, repo.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition",
                  active
                    ? "border-border"
                    : "border-transparent hover:bg-surface",
                )}
                style={
                  active
                    ? {
                        background: "var(--surface)",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                      }
                    : undefined
                }
              >
                <span
                  className="h-2 w-2 flex-none rounded-[2px]"
                  style={{ background: repoColor(repo.id) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11.5px] font-semibold text-text">
                    {repo.name}
                  </div>
                  <div className="truncate text-[9.5px] text-faint">
                    {orgName}
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      <div className="flex flex-none items-start gap-2 border-t border-border px-3.5 py-3">
        <span
          className="mt-0.5 h-[9px] w-[9px] flex-none rounded-[1.5px] border-[1.4px] border-accent"
          style={{ transform: "rotate(45deg)" }}
        />
        <div className="text-[10px] leading-relaxed text-faint">
          Atlas captures &amp; moves tickets as it works. You capture,
          prioritize &amp; promote.
        </div>
      </div>
    </aside>
  );
}
