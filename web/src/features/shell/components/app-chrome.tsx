"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { CommandPalette } from "./command-palette";
import { useAllJobsRealtime } from "@/lib/api/all-jobs-realtime";

/**
 * The persistent app chrome (client). The app-wide TOP BAR (ATLAS lockup + Threads | Tickets nav + avatar)
 * spans everything; below it sit the two destinations: the threads workspace keeps its org → repo → thread
 * sidebar, while the tickets board brings its own repo sidebar (so the org sidebar is hidden there). Owns
 * the ⌘K palette; `dialog` is the `@dialog` parallel slot (the create-job modal).
 */
export function AppChrome({
  children,
  dialog,
}: {
  children: ReactNode;
  dialog: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();
  const onTickets = pathname.startsWith("/tickets");

  // One shell-wide realtime subscription keeps every thread's "needs you" dot + status live across the
  // whole app (sidebar, dashboard, board) — independent of which thread, if any, is open.
  useAllJobsRealtime();

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {onTickets ? null : <Sidebar />}
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
        <CommandPalette open={paletteOpen} onClose={closePalette} />
        {dialog}
      </div>
    </div>
  );
}
