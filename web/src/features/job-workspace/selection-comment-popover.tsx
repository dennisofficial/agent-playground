"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MessageSquarePlus, X } from "lucide-react";
import { useReviewComments } from "./review-comments";

const MARGIN = 8;

/**
 * The floating "COMMENT ON SELECTION" popover ("Atlas Workspace HiFi") — one instance mounted at the
 * workspace root (via portal, `position:fixed`) reads the shared `pending` selection and lets the operator
 * add a note. Dismissed by outside click, Escape, or any scroll/resize (the cached selection rect goes
 * stale the instant the page moves).
 */
export function SelectionCommentPopover() {
  const { pending, addComment, cancelPending } = useReviewComments();
  const [note, setNote] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setNote("");
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    textareaRef.current?.focus();

    function onPointerDown(e: PointerEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node))
        cancelPending();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancelPending();
    }
    // Capture phase: the selection rect was measured at mouseup, so ANY scroll (including inside the
    // spec/plan scroller) or viewport resize invalidates it — dismiss rather than show a stale popover.
    function onStale() {
      cancelPending();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onStale, true);
    window.addEventListener("resize", onStale);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onStale, true);
      window.removeEventListener("resize", onStale);
    };
  }, [pending, cancelPending]);

  if (!pending || typeof document === "undefined") return null;

  const width = 290;
  const left = Math.min(
    Math.max(width / 2 + MARGIN, pending.rect.left + pending.rect.width / 2),
    window.innerWidth - width / 2 - MARGIN,
  );
  const top = Math.max(MARGIN, pending.rect.top);

  function submit() {
    addComment(note);
  }

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-[90] w-[290px] rounded-xl border border-border-2 bg-panel p-3 pb-3.5"
      style={{
        left,
        top,
        transform: "translate(-50%, calc(-100% - 12px))",
        boxShadow: "var(--shadow-menu)",
      }}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <MessageSquarePlus size={11} className="text-accent" strokeWidth={2} />
        <span className="font-mono text-[8px] font-semibold tracking-[0.07em] text-accent-2">
          COMMENT ON SELECTION
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={cancelPending}
          className="p-0.5 text-[14px] leading-none text-faint"
          aria-label="Cancel"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mb-2.5 max-h-[52px] overflow-hidden rounded-md bg-accent-soft px-2 py-1.5 font-mono text-[10px] leading-relaxed text-accent-2">
        &ldquo;{pending.quote}&rdquo;
      </div>
      <textarea
        ref={textareaRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder="Add a comment…  (⏎ to add, ⇧⏎ newline)"
        className="mb-2.5 min-h-10 w-full resize-none border-none bg-transparent text-[12.5px] leading-relaxed text-text outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <button
          type="button"
          onClick={cancelPending}
          className="rounded-lg px-[11px] py-[7px] text-[11px] font-semibold text-dim"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-[13px] py-[7px] text-[11px] font-bold text-white"
        >
          <Check size={12} strokeWidth={2.4} />
          Add comment
        </button>
      </div>
    </div>,
    document.body,
  );
}
