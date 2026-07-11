"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { JobRef } from "./job-api";
import type { PendingAttachment } from "./job-queries";
import type { ReviewComment } from "@/features/job-workspace/review-comments";

/**
 * Per-Job Composer draft store — a module singleton keyed by `jobId`, modeled on `service-log-store.ts`
 * (a `Map` of entries, per-key listener `Set`s, `useSyncExternalStore`).
 *
 * WHY an external store rather than component state: nothing keys `JobWorkspace`/`Conversation`/
 * `Composer` by `jobId`, so switching Jobs re-renders with new props but never remounts. A draft held in
 * `useState` therefore BLEEDS from one Job into the next and is lost on reload. Holding it here — loaded
 * and saved explicitly on `jobId` change — keeps each Job's draft isolated and lets it outlive the view.
 *
 * A draft is `{ text, attachments, comments }` (+ `outbox`, populated by the offline-send queue). Only the
 * SERIALIZABLE parts — `text`, `comments`, and the outbox's serializable metadata — persist to
 * `sessionStorage["atlas.composer.draft.<jobId>"]` (debounced ~300ms). Attachments are `File` + blob URL,
 * neither serializable, so they live in memory only: they survive a Job-switch but not a full reload.
 * sessionStorage (not localStorage) is intentional — a draft survives reload / in-session navigation but
 * clears when the tab/browser is fully closed.
 */

/** The offline-send queue entry — one message the operator sent while disconnected, awaiting reconnect.
 *  Populated by the offline-send-queue thread; the store just carries and persists its metadata so a
 *  queued message survives reload. `attachments` are in-memory only (Job-switch, not reload). */
export interface QueuedMessage {
  id: string;
  /** Wall-clock enqueue time — orders `allQueued()` FIFO across every Job, not just within one. */
  createdAt: number;
  text: string;
  comments: ReviewComment[];
  /** In-memory ONLY — never persisted (File + blob URL are non-serializable), same rule as draft attachments. */
  attachments: PendingAttachment[];
}

export interface ComposerDraft {
  /** Captured so the offline-send flusher can POST without a mounted view (no ref to rebuild otherwise). */
  ref: JobRef;
  text: string;
  /** In-memory ONLY — never persisted. Survives Job-switch, not a full reload. */
  attachments: PendingAttachment[];
  /** Serializable metadata; the on-screen DOM `Range`/highlight is rebuilt per-mount by the provider. */
  comments: ReviewComment[];
  /** Per-Job offline-send queue. Its serializable metadata persists; its attachments do not. */
  outbox: QueuedMessage[];
}

interface Entry {
  /** REPLACED (never mutated) on every change so `useSyncExternalStore` sees a new ref and re-renders. */
  state: ComposerDraft;
  listeners: Set<() => void>;
}

/** Shared snapshot for an unknown jobId / SSR — a stable identity keeps `useSyncExternalStore` quiet. */
const EMPTY: ComposerDraft = Object.freeze({
  ref: { orgId: "", repoId: "", jobId: "" },
  text: "",
  attachments: [],
  comments: [],
  outbox: [],
}) as ComposerDraft;

const KEY_PREFIX = "atlas.composer.draft.";
const storageKey = (jobId: string): string => `${KEY_PREFIX}${jobId}`;

/** Debounce window for a sessionStorage write — long enough to skip per-keystroke writes, short enough
 *  that a draft is safely on disk before a realistic reload. */
const PERSIST_DEBOUNCE_MS = 300;

/** The serializable projection of a draft (what actually lands in sessionStorage — no attachments). */
interface PersistedDraft {
  ref: JobRef;
  text: string;
  comments: ReviewComment[];
  outbox: Array<Pick<QueuedMessage, "id" | "text" | "comments" | "createdAt">>;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function readPersisted(jobId: string): PersistedDraft | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(jobId));
    if (!raw) return null;
    return JSON.parse(raw) as PersistedDraft;
  } catch {
    return null;
  }
}

class ComposerStore {
  private readonly entries = new Map<string, Entry>();
  private readonly persistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private notify(jobId: string): void {
    this.entries.get(jobId)?.listeners.forEach((l) => l());
  }

  /** Create + hydrate an entry for `ref.jobId` if absent (idempotent — safe to call on every render).
   *  A blank jobId is the ref-less sentinel (create-job modal) — it owns no draft, so ignore it. */
  ensure(ref: JobRef): void {
    if (!ref.jobId) return;
    if (this.entries.has(ref.jobId)) return;
    const persisted = readPersisted(ref.jobId);
    const state: ComposerDraft = {
      ref,
      text: persisted?.text ?? "",
      attachments: [],
      comments: persisted?.comments ?? [],
      // An attachments-only queued item (no text, no comments) hydrates with nothing to send — its Files
      // can't be restored, so drop it rather than leave a dead entry the flusher would silently discard.
      outbox: (persisted?.outbox ?? [])
        .map((q) => ({
          ...q,
          createdAt: q.createdAt ?? Date.now(),
          attachments: [],
        }))
        .filter((q) => q.text || q.comments.length > 0),
    };
    this.entries.set(ref.jobId, { state, listeners: new Set() });
  }

  getDraft(jobId: string): ComposerDraft {
    return this.entries.get(jobId)?.state ?? EMPTY;
  }

  subscribe(jobId: string, cb: () => void): () => void {
    if (!jobId) return () => {}; // ref-less sentinel — nothing to subscribe to
    let entry = this.entries.get(jobId);
    if (!entry) {
      // Defensive: a subscriber before `ensure`. Create a bare entry so its listeners survive.
      entry = {
        state: { ...EMPTY, attachments: [], comments: [], outbox: [] },
        listeners: new Set(),
      };
      this.entries.set(jobId, entry);
    }
    entry.listeners.add(cb);
    return () => {
      this.entries.get(jobId)?.listeners.delete(cb);
    };
  }

  private replace(ref: JobRef, next: Partial<ComposerDraft>): void {
    this.ensure(ref);
    const entry = this.entries.get(ref.jobId);
    if (!entry) return;
    entry.state = { ...entry.state, ...next };
    this.notify(ref.jobId);
  }

  setText(ref: JobRef, text: string): void {
    this.replace(ref, { text });
    this.schedulePersist(ref.jobId);
  }

  setComments(
    ref: JobRef,
    updater: (prev: ReviewComment[]) => ReviewComment[],
  ): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).comments;
    this.replace(ref, { comments: updater(prev) });
    this.schedulePersist(ref.jobId);
  }

  setAttachments(
    ref: JobRef,
    updater: (prev: PendingAttachment[]) => PendingAttachment[],
  ): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).attachments;
    // Attachments are never persisted, so no schedulePersist here.
    this.replace(ref, { attachments: updater(prev) });
  }

  setOutbox(
    ref: JobRef,
    updater: (prev: QueuedMessage[]) => QueuedMessage[],
  ): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).outbox;
    this.replace(ref, { outbox: updater(prev) });
    this.schedulePersist(ref.jobId);
  }

  /** Append a queued offline-send to a Job's outbox — called by the Composer's offline `send()` branch and
   *  by its mid-flight network-error fallback. */
  enqueue(ref: JobRef, msg: QueuedMessage): void {
    this.setOutbox(ref, (prev) => [...prev, msg]);
  }

  /** Drop one queued item once the flusher has confirmed it sent. Persists immediately (not debounced) so
   *  a reload right after a flush can't resurrect an item that already left the outbox. */
  removeQueued(jobId: string, id: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    entry.state = {
      ...entry.state,
      outbox: entry.state.outbox.filter((q) => q.id !== id),
    };
    this.notify(jobId);
    this.persistNow(jobId, entry.state);
  }

  getOutbox(jobId: string): QueuedMessage[] {
    return this.getDraft(jobId).outbox;
  }

  /**
   * Every queued message across every Job — including outboxes restored from sessionStorage by
   * `restorePersistedOutboxes()` for Jobs the operator hasn't reopened this session — sorted by
   * `createdAt` so a reconnect drains in the order the operator actually sent them, not per-Job order.
   * This is what `<OutboxFlusher>` iterates.
   */
  allQueued(): { ref: JobRef; msg: QueuedMessage }[] {
    const all: { ref: JobRef; msg: QueuedMessage }[] = [];
    for (const entry of this.entries.values()) {
      for (const msg of entry.state.outbox) all.push({ ref: entry.state.ref, msg });
    }
    return all.sort((a, b) => a.msg.createdAt - b.msg.createdAt);
  }

  /**
   * Reset a Job's DRAFT (text + attachments + comments) — called after a successful send. PRESERVES the
   * outbox, which lives in this same entry/blob: an online send clears the draft but must NOT drop queued
   * offline messages the flusher hasn't drained yet. Re-persists synchronously (cancelling any pending
   * debounced write) so the reload state is correct immediately: outbox empty → the sessionStorage entry
   * is removed; outbox non-empty → the blob is rewritten with just the queue (empty text/comments).
   *
   * Attachments are dropped WITHOUT revoking their blob URLs — matching today's send path, where a just-
   * sent batch's URLs must stay alive for the optimistic attachments card; the browser frees them on tab
   * close.
   */
  clearDraft(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) {
      // Nothing in memory, but a persisted blob may exist — clear its draft fields, keep any outbox.
      this.persistNow(jobId, null);
      return;
    }
    entry.state = {
      ...entry.state,
      text: "",
      attachments: [],
      comments: [],
    };
    this.notify(jobId);
    this.persistNow(jobId, entry.state);
  }

  private schedulePersist(jobId: string): void {
    const existing = this.persistTimers.get(jobId);
    if (existing) clearTimeout(existing);
    this.persistTimers.set(
      jobId,
      setTimeout(() => {
        this.persistTimers.delete(jobId);
        this.persistNow(jobId, this.entries.get(jobId)?.state ?? null);
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  /** Write (or remove) a Job's persisted blob immediately, cancelling any pending debounced write. When
   *  `state` is null the current persisted outbox (if any) is preserved and only the draft fields cleared. */
  private persistNow(jobId: string, state: ComposerDraft | null): void {
    const pending = this.persistTimers.get(jobId);
    if (pending) {
      clearTimeout(pending);
      this.persistTimers.delete(jobId);
    }
    if (!hasWindow()) return;

    const outbox = state?.outbox ?? readPersisted(jobId)?.outbox ?? [];
    const text = state?.text ?? "";
    const comments = state?.comments ?? [];
    const ref = state?.ref ?? readPersisted(jobId)?.ref;

    try {
      if (!text && comments.length === 0 && outbox.length === 0) {
        window.sessionStorage.removeItem(storageKey(jobId));
        return;
      }
      if (!ref) return;
      const persisted: PersistedDraft = {
        ref,
        text,
        comments,
        outbox: outbox.map((q) => ({
          id: q.id,
          text: q.text,
          comments: q.comments,
          createdAt: q.createdAt,
        })),
      };
      window.sessionStorage.setItem(
        storageKey(jobId),
        JSON.stringify(persisted),
      );
    } catch {
      // Storage full / disabled — the in-memory draft still works; persistence is best-effort.
    }
  }

  /**
   * On module load, scan sessionStorage for any persisted draft carrying a NON-empty outbox and `ensure`
   * an entry for it (using the `ref` stored in the blob), so the offline-send flusher sees queues restored
   * after a reload even for Jobs the operator hasn't reopened yet. Best-effort; malformed keys are ignored.
   */
  restorePersistedOutboxes(): void {
    if (!hasWindow()) return;
    try {
      const jobIds: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key?.startsWith(KEY_PREFIX))
          jobIds.push(key.slice(KEY_PREFIX.length));
      }
      for (const jobId of jobIds) {
        const persisted = readPersisted(jobId);
        if (persisted?.ref && (persisted.outbox?.length ?? 0) > 0) {
          this.ensure(persisted.ref);
        }
      }
    } catch {
      // Ignore — a partially-available storage just means those outboxes aren't pre-restored.
    }
  }
}

export const composerStore = new ComposerStore();
composerStore.restorePersistedOutboxes();

/**
 * Subscribe a component to one Job's Composer draft. Calls `ensure(ref)` (idempotent) so a first read
 * hydrates from sessionStorage, then reads via `useSyncExternalStore` keyed on `jobId`. `getServerSnapshot`
 * returns the shared `EMPTY` (SSR has no storage); the client re-renders from the hydrated store after
 * mount — no hydration mismatch for the controlled textarea.
 */
export function useComposerDraft(ref: JobRef): ComposerDraft {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(
    () => composerStore.getDraft(ref.jobId),
    [ref.jobId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/**
 * Slice-aware subscriptions — `attachments` / `comments` only. `replace` spreads the untouched arrays, so a
 * draft's `attachments` and `comments` refs are PRESERVED across a text edit; a `getSnapshot` that returns
 * just that array is therefore stable under keystrokes (Object.is holds) and `useSyncExternalStore` skips the
 * re-render. This keeps the transcript pane (via `useAttachments`) and the review-comments provider off the
 * per-keystroke render path — only the Composer's own text subscription re-renders while typing.
 */
export function useComposerAttachments(ref: JobRef): PendingAttachment[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(
    () => composerStore.getDraft(ref.jobId).attachments,
    [ref.jobId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.attachments);
}

export function useComposerComments(ref: JobRef): ReviewComment[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(
    () => composerStore.getDraft(ref.jobId).comments,
    [ref.jobId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.comments);
}

/** Slice-aware subscription — a Job's offline-send outbox only, so `<QueuedTray>` re-renders on enqueue/
 *  removeQueued without subscribing to text/attachments/comments changes. Same pattern as `useComposerComments`. */
export function useOutbox(ref: JobRef): QueuedMessage[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(
    () => composerStore.getDraft(ref.jobId).outbox,
    [ref.jobId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.outbox);
}
