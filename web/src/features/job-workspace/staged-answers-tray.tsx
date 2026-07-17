"use client";

import { Clock, KeyRound, X } from "lucide-react";
import type { JobRef } from "@/lib/api/job-api";
import { composerStore, useComposerStagedAnswers } from "@/lib/api/composer-store";

/**
 * The staged-answers tray above the composer ("Web: staged-answers tray" spec) — one chip per staged
 * question/file/secret answer, awaiting a batched Send. Nothing here has POSTed yet: removing a chip (or
 * "Clear all") just drops it from `composerStore`, with no network call. Mirrors `CommentTray`'s layout.
 * A secret chip NEVER renders its plaintext value — masked only.
 */
export function StagedAnswersTray({ jobRef }: { jobRef: JobRef }) {
  // Submitting entries have left the tray — they're mid-send, rendered by their card's own "sending" shell.
  const stagedAnswers = useComposerStagedAnswers(jobRef).filter(
    (a) => !a.submitting,
  );
  if (stagedAnswers.length === 0) return null;

  return (
    <div
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-surface"
      style={{ boxShadow: "0 1px 2px rgba(20,18,12,.05)" }}
    >
      <div className="flex items-center gap-2 px-3 py-[9px] pl-[13px]">
        <span className="grid h-[19px] w-[19px] flex-none place-items-center rounded-[5px] bg-accent-soft text-accent">
          <Clock size={11} strokeWidth={2.2} />
        </span>
        <span className="text-[12px] font-semibold text-text">
          {stagedAnswers.length} staged answer
          {stagedAnswers.length === 1 ? "" : "s"}
        </span>
        <span className="text-[11px] italic text-faint">
          sent together when you hit Send
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() =>
            // Preserve in-flight (`submitting`) entries — they're mid-send and already hidden from this
            // tray; wiping them here would leave `composer.tsx`'s `onError` restore with nothing to find.
            composerStore.setStagedAnswers(jobRef, (prev) => prev.filter((a) => a.submitting))
          }
          className="rounded-md px-2.5 py-[3px] text-[11px] font-medium text-dim"
        >
          Clear all
        </button>
      </div>
      {stagedAnswers.map((a) => (
        <div
          key={a.cardId}
          className="flex items-start gap-2.5 border-t border-hair px-[11px] py-2 pl-[13px] first:border-t-0"
        >
          <span className="w-0.5 flex-none self-stretch rounded-full bg-accent-line" />
          <div className="min-w-0 flex-1">
            {a.kind === "question" ? (
              <>
                <div className="truncate text-[12.5px] italic leading-snug text-dim">
                  &ldquo;{a.label}&rdquo;
                </div>
                <div className="truncate text-[12.5px] leading-snug text-text">
                  {a.answer}
                </div>
              </>
            ) : a.kind === "file" ? (
              <>
                <div className="truncate font-mono text-[12px] leading-snug text-dim">
                  {a.label}
                </div>
                <div className="truncate text-[12.5px] leading-snug text-text">
                  {a.filename}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5 text-[12.5px] leading-snug text-text">
                <KeyRound size={12} className="text-dim" />
                <span>
                  •••• for <span className="font-mono">{a.label}</span>
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => composerStore.removeStagedAnswer(jobRef, a.cardId)}
            title="Remove staged answer"
            className="grid h-5 w-5 flex-none place-items-center rounded-md text-faint"
          >
            <X size={11} strokeWidth={2.4} />
          </button>
        </div>
      ))}
    </div>
  );
}
