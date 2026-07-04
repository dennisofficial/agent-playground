"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRepoBranches } from "@/lib/api/job-queries";

/**
 * A click-away dropdown (trigger button + a render-prop menu). Shared by the create-job pickers and
 * the repo-settings base-branch picker.
 *
 * The menu renders in a `document.body` PORTAL with fixed positioning anchored to the trigger, so it
 * escapes any `overflow-hidden` ancestor (the repo card / the create-job modal both clip) instead of
 * being trapped inside it. Events from the portal still bubble through the React tree, so a portaled menu
 * inside the modal won't trip the modal's backdrop-close.
 */
export function Dropdown({
  trigger,
  header,
  children,
}: {
  trigger: React.ReactNode;
  /** Optional non-scrolling header pinned above the scrollable list (e.g. a filter box). */
  header?: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t))
        return;
      setOpen(false);
    }
    // Re-anchor on scroll (capture: catches scrolling in any ancestor) + resize.
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <div className="relative" ref={triggerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center gap-2 rounded-md border border-border-2 bg-surface px-3"
      >
        {trigger}
        <ChevronDown size={13} className="shrink-0 text-faint" />
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="fixed z-[100] flex max-h-56 flex-col overflow-hidden rounded-md border border-border bg-panel"
              style={{
                top: pos.top,
                left: pos.left,
                width: pos.width,
                boxShadow: "var(--shadow-menu)",
              }}
            >
              {header ? <div className="shrink-0">{header}</div> : null}
              <div className="overflow-y-auto py-1">
                {children(() => setOpen(false))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * A searchable base-branch picker — lists the repo's live GitHub branches (default first) with a sticky
 * filter box. Falls back to the repo's default branch until the list loads / if the fetch fails. Needs a
 * connected `repoId` (the branches endpoint hits GitHub via the org token).
 */
export function BranchPicker({
  orgId,
  repoId,
  value,
  onChange,
  fallback,
}: {
  orgId: string;
  repoId: string;
  value: string;
  onChange: (branch: string) => void;
  /** The repo's default branch — shown until the live list loads, and used if the fetch fails. */
  fallback: string;
}) {
  const { data, isLoading, isError } = useRepoBranches(orgId, repoId);
  const branches = data?.branches ?? [];
  const current = value || fallback;
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches;
  }, [branches, query]);
  // The filter is only useful once there's a list to filter — pin it as the menu header then.
  const showFilter = !isError && branches.length > 0;
  return (
    <Dropdown
      trigger={
        <>
          <GitBranch size={13} className="shrink-0 text-faint" />
          <span className="flex-1 truncate text-left font-mono text-[11.5px] text-text">
            {current}
          </span>
          {isLoading ? (
            <span className="font-mono text-[10px] text-faint">loading…</span>
          ) : null}
        </>
      }
      header={
        showFilter ? (
          <div className="flex items-center gap-1.5 border-b border-border-2 px-2.5 py-2">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter branches…"
              aria-label="Filter branches"
              autoFocus
              className="w-full bg-transparent font-mono text-[11.5px] text-text outline-none placeholder:text-faint"
            />
          </div>
        ) : undefined
      }
    >
      {(close) =>
        isError ? (
          <p className="px-3 py-2 text-[11.5px] text-faint">
            Couldn&apos;t load branches — using{" "}
            <span className="font-mono">{fallback}</span>.
          </p>
        ) : branches.length === 0 ? (
          <p className="px-3 py-2 text-[11.5px] text-faint">
            {isLoading ? "Loading branches…" : "No branches found"}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-[11.5px] text-faint">
            No branches match “{query.trim()}”.
          </p>
        ) : (
          filtered.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => {
                onChange(b);
                setQuery("");
                close();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-surface-2",
                b === current ? "text-text" : "text-dim",
              )}
            >
              <Check
                size={12}
                className={b === current ? "text-accent" : "opacity-0"}
              />
              <span className="truncate">{b}</span>
            </button>
          ))
        )
      }
    </Dropdown>
  );
}
