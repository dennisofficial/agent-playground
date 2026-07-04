"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Modal shell for the intercepted `/new` route. Closes via backdrop click, the ✕, or Escape — all
 * `router.back()`, which pops the intercepted route and restores the underlying view.
 */
export function Modal({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") router.back();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center px-4 pt-[10vh]"
      onMouseDown={() => router.back()}
    >
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.4)" }}
      />
      <div
        className="anim-pop relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-panel"
        style={{ boxShadow: "var(--shadow-palette)" }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="font-disp text-[16px] font-semibold text-text">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-[12.5px] text-dim">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
