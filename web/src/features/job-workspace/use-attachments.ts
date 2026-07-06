"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "@/lib/api/job-queries";

/** Attachment caps — mirror the backend (`MAX_ATTACHMENTS` / `MAX_ATTACHMENT_BYTES`). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Shared composer-attachment state: a pending tray of files/images with instant blob-URL previews (never
 * base64), size/count guards, image-paste extraction, and leak-safe cleanup. Used by BOTH the in-job
 * composer and the New-job modal so the pick/paste/preview logic lives once.
 *
 * `clear()` empties the tray WITHOUT revoking — a just-SENT batch's blob URLs stay alive so the optimistic
 * card can render them; `createdUrlsRef` frees every URL ever minted when the host component unmounts
 * (double-revoke is a harmless no-op). An explicit `remove()` revokes eagerly.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const createdUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = createdUrlsRef.current;
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  function add(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setAttachments((prev) => {
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
    });
  }

  function remove(idx: number) {
    setAttachments((prev) => {
      const a = prev[idx];
      if (a) URL.revokeObjectURL(a.url);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function clear() {
    setAttachments([]);
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
