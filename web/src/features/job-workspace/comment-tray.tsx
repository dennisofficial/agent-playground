"use client";

import { MessageSquarePlus, X } from "lucide-react";
import { useReviewComments } from "./review-comments";

/**
 * The queued-comments tray above the composer ("Atlas Workspace HiFi") — one chip per pending review
 * comment, grouped by file when the operator has commented across more than one. Cleared on send or via
 * "Clear all"; a comment's chip persists even after its highlight drops (a file switch invalidates the
 * on-screen Range, not the queued comment — see `review-comments.tsx`).
 */
export function CommentTray() {
  const { comments, removeComment, clearComments } = useReviewComments();
  if (comments.length === 0) return null;

  const byFile = new Map<string, typeof comments>();
  for (const c of comments) {
    const list = byFile.get(c.file.label);
    if (list) list.push(c);
    else byFile.set(c.file.label, [c]);
  }
  const multiFile = byFile.size > 1;

  return (
    <div
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-surface"
      style={{ boxShadow: "0 1px 2px rgba(20,18,12,.05)" }}
    >
      <div className="flex items-center gap-2 px-3 py-[9px] pl-[13px]">
        <span className="grid h-[19px] w-[19px] flex-none place-items-center rounded-[5px] bg-accent-soft text-accent">
          <MessageSquarePlus size={11} strokeWidth={2} />
        </span>
        <span className="text-[12px] font-semibold text-text">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
        {!multiFile ? (
          <span className="text-[11px] text-faint">
            on <span className="font-mono">{comments[0].file.label}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={clearComments}
          className="rounded-md px-2.5 py-[3px] text-[11px] font-medium text-dim"
        >
          Clear all
        </button>
      </div>
      {[...byFile.entries()].map(([file, items]) => (
        <div key={file}>
          {multiFile ? (
            <div className="border-t border-hair px-[13px] pt-2 pb-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-faint">
              {file}
            </div>
          ) : null}
          {items.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-2.5 border-t border-hair px-[11px] py-2 pl-[13px] first:border-t-0"
            >
              <span className="w-0.5 flex-none self-stretch rounded-full bg-accent-line" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] italic leading-snug text-dim">
                  &ldquo;{c.quote}&rdquo;
                </div>
                <div
                  className={`truncate text-[12.5px] leading-snug ${c.note ? "text-dim" : "text-faint"}`}
                >
                  {c.note || "No note added"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeComment(c.id)}
                title="Remove comment"
                className="grid h-5 w-5 flex-none place-items-center rounded-md text-faint"
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
