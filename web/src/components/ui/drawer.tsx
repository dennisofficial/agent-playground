"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Side = "left" | "right" | "bottom";

const PANEL_SIDE_CLASS: Record<Side, string> = {
  left: "left-0 top-0 h-full max-w-[85vw] border-r anim-drawer-left",
  right: "right-0 top-0 h-full max-w-[85vw] border-l anim-drawer-right",
  bottom: "bottom-0 left-0 right-0 max-h-[85vh] border-t anim-drawer-bottom",
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * An accessible off-canvas panel — an inline `fixed` overlay (no portal needed at this z-index scale).
 * Traps focus and locks body scroll while open; restores focus to the trigger on close.
 */
export function Drawer({
  open,
  onClose,
  side = "left",
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  side?: Side;
  children: ReactNode;
  label: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    lastFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      lastFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.3)" }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "fixed z-50 flex flex-col border-border bg-panel outline-none",
          PANEL_SIDE_CLASS[side],
        )}
        style={{ background: "var(--surface-2)" }}
      >
        {children}
      </div>
    </div>
  );
}
