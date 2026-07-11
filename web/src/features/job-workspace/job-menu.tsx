import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, MoreHorizontal, Pencil, Trash2, Unlock } from "lucide-react";
import { useAllJobs } from "@/lib/api/inbox";
import { useAddJobDependency } from "@/lib/api/job-queries";
import { qk } from "@/lib/api/query-keys";
import {
  removeJobDependency,
  ThreadApiError,
  type JobRef,
} from "@/lib/api/job-api";
import type { JobBlocker, JobStatus } from "@/lib/api/types";
import { EphemeralToast, useEphemeralToast } from "./ephemeral-toast";

/** A mutation's error, unwrapped to a message worth showing the operator — the backend's own 400 text
 *  (e.g. "can't block a job that is already building or finished…") when we have it, else a flat fallback. */
function mutationErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ThreadApiError ? err.message : fallback;
}

/** Job statuses a manual block is still meaningful for — mirrors the backend guard ("can't block a job
 *  that's already building or finished"). The backend is the source of truth (a stale client check just
 *  400s), so this only gates the UI affordance, not correctness. */
const BLOCKABLE_STATUSES = new Set<JobStatus>([
  "planning",
  "plan_review",
  "awaiting_approval",
  "blocked",
]);

/** Removes every current blocker edge in one go (the kebab "Unblock") — the backend has no batch endpoint,
 *  so this fires one `DELETE …/dependencies/:id` per blocker. */
function useUnblockJob(jobRef: JobRef, blockedBy: JobBlocker[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      Promise.all(blockedBy.map((b) => removeJobDependency(jobRef, b.jobId))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.threadPipeline(jobRef) });
      void qc.invalidateQueries({ queryKey: qk.allJobs() });
    },
  });
}

/** Kebab → "Rename job" + "Unblock" (when blocked) + "Block on another job…" + a two-click "Delete job". */
export function JobMenu({
  onStartRename,
  onDelete,
  deleting,
  hasOpenPr,
  deleteReady,
  jobRef,
  status,
  blockedBy = [],
}: {
  onStartRename?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  /** True when the job's PR is open — a single click opens the PR-choice dialog instead of arming the
   *  inline two-click confirm. */
  hasOpenPr?: boolean;
  /** True once the PR state is known — disables delete until then. */
  deleteReady?: boolean;
  /** The open job — powers the block/unblock actions (both real, server-mutating dependency edges). */
  jobRef: JobRef;
  /** The current job's UI status — gates whether "Block on another job…" is allowed. */
  status: JobStatus;
  /** The job's current blockers — "Unblock" clears every one of these edges. */
  blockedBy?: JobBlocker[];
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
        setPicking(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const canBlock = BLOCKABLE_STATUSES.has(status);
  const addDependency = useAddJobDependency(jobRef);
  const unblock = useUnblockJob(jobRef, blockedBy);
  const { toast, show: showToast } = useEphemeralToast();

  // Other jobs on the SAME repo — a job can only block on a sibling in its own repo.
  const { data: allJobs = [] } = useAllJobs();
  const pickableJobs = useMemo(
    () =>
      allJobs.filter(
        (t) =>
          t.org.id === jobRef.orgId &&
          t.repo.id === jobRef.repoId &&
          t.id !== jobRef.jobId,
      ),
    [allJobs, jobRef],
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-faint transition hover:bg-surface-2 hover:text-text"
        aria-label="Job actions"
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: "var(--shadow-menu)" }}
        >
          {onStartRename ? (
            <button
              type="button"
              onClick={() => {
                onStartRename();
                setOpen(false);
                setConfirm(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text transition hover:bg-surface-2"
            >
              <Pencil size={13} className="text-dim" />
              Rename job
            </button>
          ) : null}
          {status === "blocked" ? (
            <button
              type="button"
              disabled={unblock.isPending || blockedBy.length === 0}
              onClick={() =>
                unblock.mutate(undefined, {
                  onSuccess: () => setOpen(false),
                  onError: (err) =>
                    showToast(
                      mutationErrorMessage(err, "Couldn't unblock this job."),
                    ),
                })
              }
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text transition hover:bg-surface-2 disabled:opacity-50"
            >
              <Unlock size={13} className="text-dim" />
              {unblock.isPending ? "Unblocking…" : "Unblock"}
            </button>
          ) : null}
          <button
            type="button"
            disabled={!canBlock}
            title={
              canBlock
                ? undefined
                : "Can't block a job that's building or finished"
            }
            onClick={() => setPicking((p) => !p)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Ban size={13} className="text-dim" />
            Block on another job…
          </button>
          {picking && canBlock ? (
            <div className="max-h-48 overflow-y-auto border-t border-border py-1">
              {pickableJobs.length === 0 ? (
                <div className="px-3 py-1.5 text-[11px] text-faint">
                  No other jobs on this repo
                </div>
              ) : (
                pickableJobs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={addDependency.isPending}
                    onClick={() =>
                      addDependency.mutate(t.id, {
                        onSuccess: () => {
                          setPicking(false);
                          setOpen(false);
                        },
                        onError: (err) =>
                          showToast(
                            mutationErrorMessage(
                              err,
                              "Couldn't block that job.",
                            ),
                          ),
                      })
                    }
                    className="block w-full truncate px-3 py-1.5 text-left text-[11.5px] text-dim transition hover:bg-surface-2 hover:text-text disabled:opacity-50"
                  >
                    {t.title}
                  </button>
                ))
              )}
            </div>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              disabled={deleting || deleteReady === false}
              onClick={() => {
                if (hasOpenPr) {
                  // The modal is the confirmation — fire on a single click.
                  onDelete?.();
                } else if (confirm) {
                  // Keep the menu open so the button's "Deleting…" state is visible while the request is
                  // in flight (don't close it out from under the user — that was the "frozen, no feedback"
                  // window). The menu unmounts on the post-success navigation anyway.
                  onDelete();
                  setConfirm(false);
                } else {
                  setConfirm(true);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red transition hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)] disabled:opacity-50"
            >
              <Trash2 size={13} />
              {deleting
                ? "Deleting…"
                : confirm
                  ? "Click again to confirm"
                  : "Delete job"}
            </button>
          ) : null}
        </div>
      ) : null}
      <EphemeralToast message={toast} />
    </div>
  );
}
