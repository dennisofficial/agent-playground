"use client";

import { FileText, X } from "lucide-react";
import type { PendingAttachment } from "@/lib/api/job-queries";

/**
 * The pending-attachments tray shown in the composer / New-job modal before send — image thumbnails (local
 * blob URLs) and file chips, each with a remove button. Presentational; state lives in `useAttachments`.
 */
export function AttachmentTray({
  attachments,
  onRemove,
  className = "",
}: {
  attachments: PendingAttachment[];
  onRemove: (idx: number) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {attachments.map((a, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 rounded-lg border border-border-2 bg-panel px-2 py-1.5"
          title={a.file.name}
        >
          {a.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob object-URL preview
            <img
              src={a.url}
              alt={a.file.name}
              className="h-9 w-9 rounded object-cover"
            />
          ) : (
            <FileText size={14} strokeWidth={2} className="text-accent-2" />
          )}
          <span className="max-w-[120px] truncate text-[11px] text-text">
            {a.file.name}
          </span>
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-border-2 text-dim transition hover:bg-border hover:text-text"
            aria-label={`Remove ${a.file.name}`}
          >
            <X size={10} strokeWidth={2.6} />
          </button>
        </div>
      ))}
    </div>
  );
}
