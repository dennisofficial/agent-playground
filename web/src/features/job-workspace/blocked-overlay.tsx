"use client";

import { Lock, Unlock } from "lucide-react";
import { useUnblockJob } from "@/lib/api/job-queries";
import { mutationErrorMessage, type JobRef } from "@/lib/api/job-api";
import type { JobBlocker } from "@/lib/api/types";
import { BlockerRow, useOpenBlocker } from "./blocked-by-pane";
import { StreamTextBubble } from "./bubbles";
import { EphemeralToast, useEphemeralToast } from "./ephemeral-toast";

/**
 * The always-visible blocked banner, pinned at the TOP of the conversation pane (below the top bar, above
 * the transcript) whenever the job is `blocked`. Unlike the sidebar "Blocked by" row → right detail pane
 * (which you have to click open), this stays put so the blocker context — and the way OUT — is never hidden.
 * "Unblock now" reuses the same bulk-unblock as the kebab: it removes every dependency edge, and once the
 * last one is gone the backend flips the job off `blocked` and wakes its brain. Only rendered when there's
 * at least one blocker (the caller guards on `blockedBy.length`).
 */
export function BlockedOverlay({
  jobRef,
  blockedBy,
  blockedSeedMessage = null,
}: {
  jobRef: JobRef;
  blockedBy: JobBlocker[];
  /** The pending message this job will start on when it unblocks — previewed here so the operator can see
   *  what's incoming before it runs. Only born-blocked follow-up jobs carry one; null otherwise. */
  blockedSeedMessage?: string | null;
}) {
  const { openBlocker, toast } = useOpenBlocker(jobRef);
  const unblock = useUnblockJob(jobRef, blockedBy);
  const { toast: unblockToast, show: showUnblockError } = useEphemeralToast();

  const n = blockedBy.length;
  const seed = blockedSeedMessage?.trim();

  return (
    <div
      className="shrink-0 border-b border-border"
      style={{
        borderLeft: "3px solid var(--amber)",
        background: "color-mix(in srgb, var(--amber) 5%, var(--surface))",
      }}
    >
      <div className="mx-auto flex max-w-[880px] items-start gap-3 px-6 py-4">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "color-mix(in srgb, var(--amber) 14%, transparent)" }}
        >
          <Lock size={16} className="text-amber" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text">
            This job is blocked
          </p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-dim">
            Waiting on {n} job{n === 1 ? "" : "s"} to finish before Atlas can
            start.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {blockedBy.map((b) => (
              <BlockerRow
                key={b.jobId}
                blocker={b}
                onClick={() => openBlocker(b.jobId)}
              />
            ))}
          </div>
          {seed ? (
            <div className="mt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                When this unblocks, Atlas will start on
              </p>
              <div className="mt-1.5 rounded-lg border border-border bg-surface px-3 py-2.5">
                <StreamTextBubble text={seed} />
              </div>
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <button
              type="button"
              disabled={unblock.isPending || n === 0}
              onClick={() =>
                unblock.mutate(undefined, {
                  onError: (err) =>
                    showUnblockError(
                      mutationErrorMessage(err, "Couldn't unblock this job."),
                    ),
                })
              }
              className="flex items-center gap-1.5 rounded-lg bg-amber px-3 py-1.5 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
            >
              <Unlock size={13} strokeWidth={2.4} />
              {unblock.isPending ? "Unblocking…" : "Unblock now"}
            </button>
            <span className="text-[11px] text-faint">
              Removes the blockers so this job can start.
            </span>
          </div>
        </div>
      </div>
      <EphemeralToast message={toast} />
      <EphemeralToast message={unblockToast} />
    </div>
  );
}
