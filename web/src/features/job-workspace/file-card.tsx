"use client";

import { useRef, useState } from "react";
import { CheckCircle2, Clock, FileUp, XCircle } from "lucide-react";
import { Markdown } from "./markdown";
import type { JobRef } from "@/lib/api/job-api";
import type { WebFileRequestCard } from "@/lib/api/types";
import {
  composerStore,
  useComposerStagedAnswers,
  type StagedAnswer,
} from "@/lib/api/composer-store";

/** Max upload size, kept in lockstep with the backend `MAX_FILE_UPLOAD_BYTES`. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * A secure file-upload request the onboarding brain posed via `request_file`. Renders a file picker; the
 * chosen file is read as text client-side and STAGED into the composer's tray the instant it's picked (no
 * separate confirm step) — nothing hits the backend until the operator's batched Send, which POSTs to
 * `…/threads/:jobId/answer-batch`. The contents are never echoed back or kept in the card. Once
 * `provided_at` is set, renders the compact "uploaded" state.
 */
export function FileCardView({
  card,
  jobRef,
}: {
  card: WebFileRequestCard;
  jobRef: JobRef;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [tooBig, setTooBig] = useState(false);
  const staged = useComposerStagedAnswers(jobRef).find(
    (a): a is Extract<StagedAnswer, { kind: "file" }> =>
      a.kind === "file" && a.cardId === card.requestId,
  );

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setTooBig(true);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setTooBig(false);
    const filename = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      composerStore.stageAnswer(jobRef, {
        kind: "file",
        cardId: card.requestId,
        label: card.path,
        filename,
        content,
      });
    };
    reader.readAsText(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (staged) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-dashed border-accent-line bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Clock size={15} className="text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-text">
              <span className="font-mono">{card.path}</span>
            </p>
            <p className="truncate text-[12.5px] text-dim">
              <span className="font-mono">{staged.filename}</span>
            </p>
            <p className="text-[11px] text-faint">Staged — not yet sent</p>
          </div>
          <button
            type="button"
            onClick={() =>
              composerStore.removeStagedAnswer(jobRef, card.requestId)
            }
            className="rounded-md px-2 py-1 text-[11.5px] font-medium text-dim hover:text-text"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  if (card.withdrawnAt != null && card.provided_at == null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <XCircle size={15} className="text-faint" />
          <div className="min-w-0">
            <p className="truncate font-mono text-[12.5px] text-dim line-through">
              {card.path}
            </p>
            <p className="text-[12px] text-faint">
              Withdrawn
              {card.withdrawnReason ? ` — ${card.withdrawnReason}` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (card.provided_at != null) {
    return (
      <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <CheckCircle2 size={15} style={{ color: "var(--green)" }} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text">
              <span className="font-mono">{card.path}</span> uploaded
            </p>
            <p className="truncate text-[12.5px] text-dim">
              stored encrypted · granted
              {card.filename ? (
                <>
                  {" "}
                  · <span className="font-mono">{card.filename}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="anim-pop self-stretch overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <FileUp size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-text">Upload file</span>
        <div className="flex-1" />
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9.5px] text-dim">
          {card.path}
        </span>
      </div>

      <div className="px-4 py-3">
        <Markdown>{card.description}</Markdown>
        <p className="mt-1.5 text-[11.5px] leading-snug text-dim">
          Sent once, encrypted at rest — the contents never appear in the
          conversation or are shown back to Atlas.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border bg-surface-2 px-4 py-3">
        <input
          ref={inputRef}
          type="file"
          onChange={onPick}
          className="block w-full text-[12.5px] text-text file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-2.5 file:py-1.5 file:text-[12.5px] file:text-text hover:file:border-accent"
        />
        {tooBig ? (
          <span className="text-[11.5px] text-red">
            File is larger than {Math.floor(MAX_FILE_BYTES / 1024)} KB — pick a
            smaller config/key file.
          </span>
        ) : null}
      </div>
    </div>
  );
}
