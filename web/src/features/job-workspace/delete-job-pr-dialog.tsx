"use client";

import { Archive } from "lucide-react";

/**
 * The secondary confirmation shown when archiving a job whose PR is still OPEN — the inline two-click
 * kebab confirm isn't enough here because archiving the job doesn't automatically touch the PR, so the
 * operator needs to explicitly choose whether to close it. Modeled on `DeleteOrgDialog`.
 */
export function DeleteJobPrDialog({
  prNumber,
  pending,
  error,
  onChoose,
  onClose,
}: {
  prNumber?: number | null;
  pending: boolean;
  error?: Error | null;
  onChoose: (action: "close" | "leave") => void;
  onClose: () => void;
}) {
  return (
    <div
      onMouseDown={() => {
        if (pending) return;
        onClose();
      }}
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[120px]"
      style={{ background: "rgba(10,12,16,0.5)", backdropFilter: "blur(3px)" }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[440px] max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.4)" }}
        role="dialog"
        aria-modal
      >
        <div className="p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-red"
              style={{
                background: "color-mix(in srgb, var(--red) 8%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--red) 40%, transparent)",
              }}
            >
              <Archive size={17} />
            </span>
            <div className="font-disp text-[16px] font-semibold text-text">
              Archive this job?
            </div>
          </div>
          <p className="mb-1.5 text-[12.5px] leading-relaxed text-dim">
            This job has{" "}
            {prNumber != null
              ? `an open pull request (#${prNumber})`
              : "an open pull request"}
            . Archiving the job won&apos;t touch the PR unless you close it.
          </p>
          {error ? (
            <p className="mt-2.5 text-[11.5px] text-red">
              {error.message ?? "Could not archive the job."}
            </p>
          ) : null}
        </div>
        <div
          className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3.5"
          style={{ background: "var(--surface-2)" }}
        >
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="rounded-md border border-border-2 px-3.5 py-2 text-[12.5px] font-medium text-dim transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onChoose("leave")}
            className="rounded-md border border-border-2 px-3.5 py-2 text-[12.5px] font-medium text-dim transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending ? "Working…" : "Leave PR open & archive"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onChoose("close")}
            className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: "var(--red)" }}
          >
            {pending ? "Working…" : "Close PR & archive"}
          </button>
        </div>
      </div>
    </div>
  );
}
