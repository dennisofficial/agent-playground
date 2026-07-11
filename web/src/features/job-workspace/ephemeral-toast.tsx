"use client";

import { useEffect, useRef, useState } from "react";

const TOAST_DURATION_MS = 5000;

/**
 * A tiny fire-and-forget notice — no toast library, just local state + a cleared-on-unmount timer (mirrors
 * the file-copy "Copied" pattern in `step-view.tsx`). Meant for actions whose only failure mode is "the
 * target no longer exists" (a resolve-then-navigate 404), where a full error UI would be overkill.
 */
export function useEphemeralToast() {
  const [message, setMessage] = useState<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const show = (text: string) => {
    setMessage(text);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setMessage(null), TOAST_DURATION_MS);
  };

  return { toast: message, show };
}

/**
 * Fixed-position ephemeral status line. `role="status"`/`aria-live="polite"` so screen readers announce it
 * without stealing focus; renders nothing while `message` is null. Uses the house `anim-pop` transform
 * (never an opacity fade — see `globals.css` §5) for its entrance.
 */
export function EphemeralToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2"
    >
      <div
        role="status"
        aria-live="polite"
        className="anim-pop rounded-md border border-border bg-panel px-3.5 py-2 text-[12px] font-medium text-text"
        style={{ boxShadow: "var(--shadow-menu)" }}
      >
        {message}
      </div>
    </div>
  );
}
