import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Ban, MoreHorizontal, Pencil, Unlock } from "lucide-react";
import { useAllJobs } from "@/lib/api/inbox";
import { useAddJobDependency, useUnblockJob } from "@/lib/api/job-queries";
import { mutationErrorMessage, type JobRef } from "@/lib/api/job-api";
import {
  groupThreadsBySection,
  SECTION_LABEL,
} from "@/lib/api/job-section";
import type { JobBlocker, JobStatus } from "@/lib/api/types";
import { EphemeralToast, useEphemeralToast } from "./ephemeral-toast";

/** Job statuses a manual block is still meaningful for — mirrors the backend guard ("can't block a job
 *  that's already building or finished"). The backend is the source of truth (a stale client check just
 *  400s), so this only gates the UI affordance, not correctness. */
const BLOCKABLE_STATUSES = new Set<JobStatus>([
  "planning",
  "plan_review",
  "awaiting_approval",
  "blocked",
]);

/** Kebab → "Rename job" + "Unblock" (when blocked) + "Block on another job…" + a two-click "Archive job". */
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

  // Other jobs on the SAME repo — a job can only block on a sibling in its own repo. Grouped + ordered
  // into the same sections as the sidebar (Planning → Blocked → Building → Ready to Ship → PR Open …) so
  // it's easy to find the right blocker; `merged` jobs are skipped (blocking on an already-merged job is
  // pointless — its terminal state would just clear the block immediately).
  const { data: allJobs = [] } = useAllJobs();
  const pickableSections = useMemo(() => {
    const pickable = allJobs.filter(
      (t) =>
        t.org.id === jobRef.orgId &&
        t.repo.id === jobRef.repoId &&
        t.id !== jobRef.jobId,
    );
    return groupThreadsBySection(pickable).filter((g) => g.section !== "merged");
  }, [allJobs, jobRef]);

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
            <div className="max-h-60 overflow-y-auto border-t border-border py-1">
              {pickableSections.length === 0 ? (
                <div className="px-3 py-1.5 text-[11px] text-faint">
                  No other jobs on this repo
                </div>
              ) : (
                pickableSections.map(({ section, threads }) => (
                  <div key={section}>
                    <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wide text-faint">
                      {SECTION_LABEL[section]}
                    </div>
                    {threads.map((t) => (
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
                    ))}
                  </div>
                ))
              )}
            </div>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              disabled={
                deleting || deleteReady === false || status === "archived"
              }
              onClick={() => {
                if (hasOpenPr) {
                  // The modal is the confirmation — fire on a single click.
                  onDelete?.();
                } else if (confirm) {
                  // Keep the menu open so the button's "Archiving…" state is visible while the request is
                  // in flight (don't close it out from under the user — that was the "frozen, no feedback"
                  // window). Archiving stays on this page, so the menu just closes once the mutation settles.
                  onDelete();
                  setConfirm(false);
                } else {
                  setConfirm(true);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red transition hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)] disabled:opacity-50"
            >
              <Archive size={13} />
              {deleting
                ? "Archiving…"
                : confirm
                  ? "Click again to confirm"
                  : "Archive job"}
            </button>
          ) : null}
        </div>
      ) : null}
      <EphemeralToast message={toast} />
    </div>
  );
}
