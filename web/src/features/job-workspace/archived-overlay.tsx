"use client";

import { Archive } from "lucide-react";

/**
 * The always-visible archived banner, pinned at the TOP of the conversation pane whenever the job is
 * `archived`. Archiving is terminal and irreversible in v1 (no restore/unarchive) — this is informational
 * only, unlike `BlockedOverlay` which offers a way out.
 */
export function ArchivedOverlay() {
  return (
    <div
      className="shrink-0 border-b border-border"
      style={{
        borderLeft: "3px solid var(--faint)",
        background: "color-mix(in srgb, var(--faint) 5%, var(--surface))",
      }}
    >
      <div className="mx-auto flex max-w-[880px] items-start gap-3 px-6 py-4">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "color-mix(in srgb, var(--faint) 14%, transparent)" }}
        >
          <Archive size={16} className="text-faint" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-text">This job is archived</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-dim">
            Its workspace was reclaimed. History is read-only.
          </p>
        </div>
      </div>
    </div>
  );
}
