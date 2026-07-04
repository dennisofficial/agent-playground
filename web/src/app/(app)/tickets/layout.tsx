import type { ReactNode } from "react";
import { RepoSidebar } from "@/features/tickets/repo-sidebar";

/**
 * The tickets shell (under the app-wide top bar). Its own repo-picker sidebar + the board/backlog content;
 * the threads org→repo→thread sidebar is hidden here (AppChrome drops it on `/tickets`). The active repo is
 * derived from the route inside `RepoSidebar`.
 */
export default function TicketsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <RepoSidebar />
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
