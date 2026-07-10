"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Side = "left" | "right" | "bottom";

const PANEL_SIDE_CLASS: Record<Side, string> = {
  left: "left-0 top-0 h-full border-r anim-drawer-left",
  right: "right-0 top-0 h-full border-l anim-drawer-right",
  bottom: "bottom-0 left-0 right-0 max-h-[85vh] border-t anim-drawer-bottom",
};

/** Default width for side-anchored panels; overridable via the `widthClass` prop (e.g. a full-width Detail
 * sheet on mobile). The bottom sheet spans the full width, so it opts out. */
const DEFAULT_SIDE_WIDTH_CLASS = "w-[85vw] max-w-[360px]";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

let bodyScrollLockCount = 0;
let previousBodyOverflow = "";

function lockBodyScroll() {
  if (bodyScrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
}

function unlockBodyScroll(): boolean {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount !== 0) return false;
  document.body.style.overflow = previousBodyOverflow;
  previousBodyOverflow = "";
  return true;
}

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
  widthClass,
}: {
  open: boolean;
  onClose: () => void;
  side?: Side;
  children: ReactNode;
  label: string;
  /** Overrides the default `max-w-[85vw]` width cap for a left/right panel (ignored for `bottom`).
   *  Lets a caller render, e.g., a full-width Detail sheet on mobile. */
  widthClass?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    lastFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    lockBodyScroll();

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
      if (unlockBodyScroll()) lastFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.3)" }}
      />
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
          side !== "bottom" && (widthClass ?? DEFAULT_SIDE_WIDTH_CLASS),
        )}
        style={{ background: "var(--surface-2)" }}
      >
        {children}
      </div>
    </div>
  );
}
