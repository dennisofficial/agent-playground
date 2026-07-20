'use client';

import { composerStore, useComposerAttachments } from '@/lib/api/composer-store';
import { addDraftAttachment, type JobRef } from '@/lib/api/job-api';
import type { DraftAttachment, PendingAttachment } from '@/lib/api/job-queries';
import { useEffect, useRef, useState } from 'react';

export const MAX_ATTACHMENTS = 25;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The shared composer attachment-tray API. Store-mode (in-job composer) tray items are server-backed
 *  `DraftAttachment`s (uploaded on-add); local-mode (New-job modal) items keep the raw `File`. */
export interface AttachmentsApi {
  attachments: DraftAttachment[];
  error: string | null;
  add: (files: File[]) => void;
  remove: (idx: number) => void;
  clear: () => void;
  addPastedImages: (e: React.ClipboardEvent) => boolean;
}

/** The local-mode variant (New-job modal) — identical API, but the tray still carries raw `File`s so the
 *  modal can upload them at create time (`createJobWithFiles`). */
export interface LocalAttachmentsApi extends Omit<AttachmentsApi, 'attachments'> {
  attachments: PendingAttachment[];
}

/**
 * Shared composer-attachment state: a pending tray of files/images with instant blob-URL previews (never
 * base64), size/count guards, image-paste extraction, and leak-safe cleanup. Used by BOTH the in-job
 * composer and the New-job modal so the pick/paste/preview logic lives once.
 *
 * Two modes, keyed on whether a `ref` is passed:
 *
 * - **ref present** (the in-Job Composer): SERVER-BACKED. Each picked file uploads immediately to the job's
 *   server draft (`POST .../draft/attachments`); the tray shows an instant local blob preview, then merges
 *   the server row (`id`/name/kind/size) once the upload resolves. Backed by the per-Job `composerStore`,
 *   so the tray is isolated per Job, survives a Job-switch, syncs across the operator's devices, and is
 *   promoted onto the message by the send-path server-side (no bytes are sent at send time). Blob previews
 *   are revoked on explicit `remove`; the rest are freed by the browser on tab close.
 * - **ref absent** (the New-job modal, before any Job exists): a local `useState` tray with an unmount-time
 *   revoke sweep. No server, no persistence (there's no Job to key on); files upload at create time.
 *
 * `error` is transient UI in BOTH modes (local state, not persisted).
 */
export function useAttachments(ref: JobRef): AttachmentsApi;
export function useAttachments(): LocalAttachmentsApi;
export function useAttachments(ref?: JobRef): AttachmentsApi | LocalAttachmentsApi {
  const storeMode = !!ref?.jobId;
  // Always call both hooks (rules of hooks); only one drives the tray. The store hook ignores a blank ref.
  const storeAttachments = useComposerAttachments(ref ?? EMPTY_REF);
  const [localAttachments, setLocalAttachments] = useState<PendingAttachment[]>([]);

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
   *  effect (safe — this runs synchronously inside an event handler / store updater). LOCAL mode only. */
  function applyAdd(prev: PendingAttachment[], files: File[]): PendingAttachment[] {
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
        kind: file.type.startsWith('image/') ? 'image' : 'file',
      });
    }
    return next;
  }

  /** Store mode: show an optimistic preview immediately, upload, then merge the server row (or roll back on
   *  failure). If the operator removed the chip before the upload resolved, delete the just-created row. */
  function uploadOne(jobRef: JobRef, file: File): void {
    const tempId = `pending-${crypto.randomUUID()}`;
    const url = URL.createObjectURL(file);
    createdUrlsRef.current.push(url);
    const kind = file.type.startsWith('image/') ? 'image' : 'file';
    composerStore.setAttachments(jobRef, (prev) => [
      ...prev,
      {
        id: tempId,
        name: file.name,
        kind,
        size: file.size,
        url,
        pending: true,
      },
    ]);
    void addDraftAttachment(jobRef, file)
      .then((dto) => {
        const present = composerStore
          .getDraft(jobRef.jobId)
          .attachments.some((a) => a.id === tempId);
        if (!present) {
          composerStore.deleteAttachment(jobRef, dto.id);
          return;
        }
        composerStore.setAttachments(jobRef, (prev) =>
          prev.map((a) =>
            a.id === tempId
              ? {
                  id: dto.id,
                  name: dto.name,
                  kind: dto.kind,
                  size: dto.size,
                  url,
                }
              : a,
          ),
        );
      })
      .catch(() => {
        composerStore.setAttachments(jobRef, (prev) => prev.filter((a) => a.id !== tempId));
        URL.revokeObjectURL(url);
        setError(`Couldn't upload "${file.name}" — try again.`);
      });
  }

  function add(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    if (storeMode && ref) {
      // Apply the caps up front (instant feedback), then upload each accepted file to the server draft.
      let count = composerStore.getDraft(ref.jobId).attachments.length;
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          setError(`Up to ${MAX_ATTACHMENTS} attachments.`);
          break;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          setError(`"${file.name}" is too large (max 10 MB).`);
          continue;
        }
        count++;
        uploadOne(ref, file);
      }
    } else {
      setLocalAttachments((prev) => applyAdd(prev, files));
    }
  }

  function remove(idx: number) {
    if (storeMode && ref) {
      const a = composerStore.getDraft(ref.jobId).attachments[idx];
      if (!a) return;
      if (a.url) URL.revokeObjectURL(a.url); // eager revoke on explicit removal
      composerStore.setAttachments(ref, (prev) => prev.filter((_, i) => i !== idx));
      // A still-pending entry has only a client temp id — no server row to delete yet (the in-flight
      // upload's own resolve handler cleans up its row once it sees the entry is gone).
      if (!a.pending) composerStore.deleteAttachment(ref, a.id);
      return;
    }
    const revokeAt = (prev: PendingAttachment[]) => {
      const a = prev[idx];
      if (a) URL.revokeObjectURL(a.url);
      return prev.filter((_, i) => i !== idx);
    };
    setLocalAttachments(revokeAt);
  }

  function clear() {
    // Drop the tray WITHOUT revoking blob URLs — a just-sent batch's URLs stay alive for the optimistic
    // card. Store mode does NOT delete server rows here: the send path promotes+clears the server draft
    // (online) or the reconnect send promotes whatever is still staged (offline); `clear()` is only ever
    // called as part of a send, so leaving the rows for the server to consume is correct.
    if (storeMode && ref) composerStore.setAttachments(ref, () => []);
    else setLocalAttachments([]);
    setError(null);
  }

  /** Extract pasted images from a clipboard event. Returns true if any were added (caller should preventDefault). */
  function addPastedImages(e: React.ClipboardEvent): boolean {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
      // Pasted screenshots have no name — synthesize one from the MIME subtype.
      .map((f) =>
        f.name
          ? f
          : new File([f], `pasted-${Date.now()}.${f.type.split('/')[1] || 'png'}`, {
              type: f.type,
            }),
      );
    if (imgs.length === 0) return false;
    add(imgs);
    return true;
  }

  const api = { error, add, remove, clear, addPastedImages };
  return storeMode
    ? { ...api, attachments: storeAttachments }
    : { ...api, attachments: localAttachments };
}

const EMPTY_REF: JobRef = { orgId: '', repoId: '', jobId: '' };
