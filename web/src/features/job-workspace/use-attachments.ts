"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "@/lib/api/job-queries";
import type { JobRef } from "@/lib/api/job-api";
import {
  composerStore,
  useComposerAttachments,
} from "@/lib/api/composer-store";

/** Attachment caps — mirror the backend (`MAX_ATTACHMENTS` / `MAX_ATTACHMENT_BYTES`). */
export const MAX_ATTACHMENTS = 25;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Shared composer-attachment state: a pending tray of files/images with instant blob-URL previews (never
 * base64), size/count guards, image-paste extraction, and leak-safe cleanup. Used by BOTH the in-job
 * composer and the New-job modal so the pick/paste/preview logic lives once.
 *
 * Two modes, keyed on whether a `ref` is passed:
 *
 * - **ref present** (the in-Job Composer): the tray is backed by the per-Job `composerStore` so attachments
 *   are isolated per Job and SURVIVE a Job-switch (the component tree never remounts on switch). Because the
 *   tray now OUTLIVES this component, there is no unmount-time revoke sweep — blob URLs are revoked only on
 *   explicit `remove()`; the rest are freed by the browser on tab close (matching today's leak posture, and
 *   the reason `clear()` drops without revoking so a just-sent optimistic card can still render them).
 * - **ref absent** (the New-job modal, before any Job exists): TODAY's behavior exactly — a local `useState`
 *   tray with an unmount-time revoke sweep. No store, no persistence (there's no Job to key on).
 *
 * `error` is transient UI in BOTH modes (local state, not persisted).
 */
export function useAttachments(ref?: JobRef) {
  const storeMode = !!ref?.jobId;
  // Always call both hooks (rules of hooks); only one drives the tray. The store hook ignores a blank ref.
  const storeAttachments = useComposerAttachments(ref ?? EMPTY_REF);
  const [localAttachments, setLocalAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const attachments = storeMode ? storeAttachments : localAttachments;

  const [error, setError] = useState<string | null>(null);
  const createdUrlsRef = useRef<string[]>([]);

  // Unmount revoke sweep — LOCAL mode only. In store mode the tray outlives this component, so revoking on
  // unmount would break a still-open Job's previews after a Job-switch.
  useEffect(() => {
    if (storeMode) return;
    const urls = createdUrlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [storeMode]);

  /** Apply the caps + build blob previews for a batch, returning the next tray. Sets `error` as a side
   *  effect (safe — this runs synchronously inside an event handler / store updater). */
  function applyAdd(
    prev: PendingAttachment[],
    files: File[],
  ): PendingAttachment[] {
    const next = [...prev];
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENTS) {
        setError(`Up to ${MAX_ATTACHMENTS} attachments.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is too large (max 10 MB).`);
        continue;
      }
      const url = URL.createObjectURL(file);
      createdUrlsRef.current.push(url);
      next.push({
        file,
        url,
        kind: file.type.startsWith("image/") ? "image" : "file",
      });
    }
    return next;
  }

  function add(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    if (storeMode && ref) {
      composerStore.setAttachments(ref, (prev) => applyAdd(prev, files));
    } else {
      setLocalAttachments((prev) => applyAdd(prev, files));
    }
  }

  function remove(idx: number) {
    const revokeAt = (prev: PendingAttachment[]) => {
      const a = prev[idx];
      if (a) URL.revokeObjectURL(a.url); // eager revoke on explicit removal (both modes)
      return prev.filter((_, i) => i !== idx);
    };
    if (storeMode && ref) composerStore.setAttachments(ref, revokeAt);
    else setLocalAttachments(revokeAt);
  }

  function clear() {
    // Drop WITHOUT revoking — a just-sent batch's blob URLs stay alive for the optimistic card.
    if (storeMode && ref) composerStore.setAttachments(ref, () => []);
    else setLocalAttachments([]);
    setError(null);
  }

  /** Extract pasted images from a clipboard event. Returns true if any were added (caller should preventDefault). */
  function addPastedImages(e: React.ClipboardEvent): boolean {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
      // Pasted screenshots have no name — synthesize one from the MIME subtype.
      .map((f) =>
        f.name
          ? f
          : new File(
              [f],
              `pasted-${Date.now()}.${f.type.split("/")[1] || "png"}`,
              { type: f.type },
            ),
      );
    if (imgs.length === 0) return false;
    add(imgs);
    return true;
  }

  return { attachments, error, add, remove, clear, addPastedImages };
}

/** The ref-less sentinel — the store treats a blank jobId as "no draft" (create-job modal). */
const EMPTY_REF: JobRef = { orgId: "", repoId: "", jobId: "" };

/** The shared attachment tray API — lifted to the transcript so a pane-wide drop can add into the composer. */
export type AttachmentsApi = ReturnType<typeof useAttachments>;
