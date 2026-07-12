"use client";

import { useRouter } from "next/navigation";
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Lock,
} from "lucide-react";
import { threadHref } from "@/lib/routes";
import { resolveJob, ThreadApiError, type JobRef } from "@/lib/api/job-api";
import { STATUS_META, toJobStatus } from "@/lib/api/status";
import type { JobBlocker, WireJobStatus } from "@/lib/api/types";
import { EphemeralToast, useEphemeralToast } from "./ephemeral-toast";

/**
 * The "Blocked by" detail pane — the live blockers holding this job in `blocked` (`PipelineJob.blockedBy`).
 * A job block is real gating: the brain never runs while a blocker is outstanding, and the wake path
 * clears it automatically once every blocker reaches a terminal state. Each row resolves the blocker before
 * navigating — a hard-deleted blocker 404s, so we toast instead of routing into a dead job.
 */
/**
 * Navigate to a blocker job — shared by the "Blocked by" detail pane and the conversation-pane blocked
 * overlay. Resolves the blocker first (a hard-deleted blocker 404s, so we toast instead of routing into a
 * dead job). Returns the click handler + the toast element to render.
 */
export function useOpenBlocker(jobRef: JobRef) {
  const router = useRouter();
  const { toast, show } = useEphemeralToast();
  const openBlocker = async (blockerJobId: string) => {
    try {
      await resolveJob({ ...jobRef, jobId: blockerJobId });
      router.push(
        threadHref({
          orgId: jobRef.orgId,
          repoId: jobRef.repoId,
          jobId: blockerJobId,
        }),
      );
    } catch (err) {
      if (err instanceof ThreadApiError && err.status === 404) {
        show("This job was deleted.");
      } else {
        console.error("Failed to resolve blocker job", err);
      }
    }
  };
  return { openBlocker, toast };
}

export function BlockedByPane({
  jobRef,
  blockedBy,
}: {
  jobRef: JobRef;
  blockedBy: JobBlocker[];
}) {
  const { openBlocker, toast } = useOpenBlocker(jobRef);

  if (blockedBy.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <Lock size={22} className="text-faint" />
        <p className="text-[13px] font-medium text-text">Not blocked</p>
        <p className="max-w-xs text-[12px] leading-snug text-dim">
          This job has no outstanding blockers.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
        {blockedBy.length} blocking this job
      </p>
      {blockedBy.map((b) => (
        <BlockerRow
          key={b.jobId}
          blocker={b}
          onClick={() => openBlocker(b.jobId)}
        />
      ))}
      <p className="mt-1 text-[10.5px] italic leading-relaxed text-faint">
        This job is parked until its blockers resolve — it wakes automatically
        when they merge (or otherwise finish).
      </p>
      <EphemeralToast message={toast} />
    </div>
  );
}

export function BlockerRow({
  blocker,
  onClick,
}: {
  blocker: JobBlocker;
  onClick: () => void;
}) {
  const status = toJobStatus(blocker.status as WireJobStatus);
  const meta = STATUS_META[status];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-4 py-3 text-left transition hover:bg-surface-2"
    >
      <span
        className="h-[7px] w-[7px] shrink-0 rounded-full"
        style={{ background: meta.color }}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
        {blocker.title || "Untitled job"}
      </span>
      {blocker.prState ? <PrStateChip state={blocker.prState} /> : null}
      <span
        className="shrink-0 font-mono text-[9.5px] uppercase"
        style={{ color: meta.color }}
      >
        {meta.label}
      </span>
    </button>
  );
}

/** A compact PR-state chip (icon + word) — same GitHub color convention as `created-jobs-pane.tsx`. */
function PrStateChip({ state }: { state: string }) {
  const { Icon, color, label } =
    state === "merged"
      ? { Icon: GitMerge, color: "var(--purple)", label: "merged" }
      : state === "closed"
        ? { Icon: GitPullRequestClosed, color: "var(--red)", label: "closed" }
        : { Icon: GitPullRequest, color: "var(--green)", label: "open" };
  return (
    <span
      className="flex shrink-0 items-center gap-1 font-mono text-[9.5px] uppercase"
      style={{ color }}
    >
      <Icon size={10} />
      {label}
    </span>
  );
}
