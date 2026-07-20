'use client';

import type { ReviewComment } from '@/features/job-workspace/components/review/review-comments';
import { useCallback, useSyncExternalStore } from 'react';
import { connectivity } from './connectivity';
import {
  deleteDraftAttachment,
  getDraft,
  putDraft,
  type DraftAttachmentDto,
  type DraftPayloadWire,
  type JobMessage,
  type JobRef,
} from './job-api';
import type { DraftAttachment } from './job-queries';

/**
 * Per-Job Composer draft store — a module singleton keyed by `jobId`, modeled on `service-log-store.ts`
 * (a `Map` of entries, per-key listener `Set`s, `useSyncExternalStore`).
 *
 * WHY an external store rather than component state: nothing keys `JobWorkspace`/`Conversation`/
 * `Composer` by `jobId`, so switching Jobs re-renders with new props but never remounts. A draft held in
 * `useState` therefore BLEEDS from one Job into the next and is lost on reload. Holding it here — loaded
 * and saved explicitly on `jobId` change — keeps each Job's draft isolated and lets it outlive the view.
 *
 * A draft is `{ text, attachments, comments, stagedAnswers }` (+ `outbox`, populated by the offline-send
 * queue). The draft body is SERVER-BACKED per (job, user): `text`/`stagedAnswers`/`comments` autosave to
 * `PUT .../draft` (debounced) and attachments upload on-add to `POST .../draft/attachments`, so a draft
 * syncs across the operator's own devices (via the drafts realtime stream) and survives a full reload.
 * `sessionStorage["atlas.composer.draft.<jobId>"]` is kept only as an OFFLINE FALLBACK buffer — read first
 * for an instant paint, then OVERWRITTEN the moment the server responds (server wins over stale storage).
 * The `outbox` (offline-send queue) is unchanged: still sessionStorage-only serializable metadata.
 */

/** The offline-send queue entry — one message the operator sent while disconnected, awaiting reconnect.
 *  The store carries and persists its metadata so a queued message survives reload. `hasAttachments` is a
 *  flag, not the bytes: the attachments themselves already live on the server draft (uploaded on-add), and
 *  the reconnect-time send promotes whatever is still staged there. */
export interface QueuedMessage {
  id: string;
  /** Wall-clock enqueue time — orders `allQueued()` FIFO across every Job, not just within one. */
  createdAt: number;
  text: string;
  comments: ReviewComment[];
  /** The composer had staged draft attachments at enqueue time — the reconnect send omits `files` so the
   *  server promotes the already-uploaded draft attachments onto the message. */
  hasAttachments: boolean;
}

/**
 * One card's answer staged (not yet sent) into the tray above the Composer — a question pick, a picked
 * file, or a durable/MCP secret value. `cardId` is the card's own id (`questionId`/`requestId`); one entry
 * per `cardId` (re-staging replaces). Held in memory only — file/secret content is sensitive (never
 * serialized to sessionStorage), and question answers are cheap to re-enter after a reload.
 */
export type StagedAnswer = (
  | { kind: 'question'; cardId: string; label: string; answer: string }
  | {
      kind: 'file';
      cardId: string;
      label: string;
      filename: string;
      content: string;
    }
  | { kind: 'secret'; cardId: string; label: string; value: string }
) & {
  /** Set true the instant Send is hit — the tray filters these out and the card shows a "sending…" shell
   *  instead of reverting to its open/staged state, until the batch settles (success removes it via
   *  `pruneStagedAnswers`; failure reverts it back to false). */
  submitting?: boolean;
};

export interface ComposerDraft {
  /** Captured so the offline-send flusher can POST without a mounted view (no ref to rebuild otherwise). */
  ref: JobRef;
  text: string;
  /** Server-backed (uploaded on-add). A hydrated entry carries no blob preview `url`, just name/kind/size. */
  attachments: DraftAttachment[];
  /** Server-backed. The on-screen DOM `Range`/highlight is rebuilt per-mount by the provider. */
  comments: ReviewComment[];
  /** Per-Job offline-send queue. sessionStorage-only serializable metadata (NOT server-backed). */
  outbox: QueuedMessage[];
  /** Server-backed. One staged answer per card, awaiting a batched Send. */
  stagedAnswers: StagedAnswer[];
}

interface Entry {
  /** REPLACED (never mutated) on every change so `useSyncExternalStore` sees a new ref and re-renders. */
  state: ComposerDraft;
  listeners: Set<() => void>;
  /** Wall-clock of the last LOCAL edit — the last-write-wins clock that decides whether an incoming server
   *  payload (a realtime echo) is fresher than an unsynced local change. */
  lastLocalEditAt: number;
  /** A local edit is not yet confirmed by the server (a `putDraft` still owed) — re-sent on reconnect. */
  dirty: boolean;
  /** Attachment ids whose server-side delete hasn't been confirmed yet (never attempted while offline, or
   *  failed) — retried on reconnect, same as `dirty` retries the draft-body autosave. Prevents a failed/
   *  offline DELETE from silently orphaning the row so it later reattaches to the next sent message. */
  pendingDeletes: Set<string>;
}

const EMPTY: ComposerDraft = Object.freeze({
  ref: { orgId: '', repoId: '', jobId: '' },
  text: '',
  attachments: [],
  comments: [],
  outbox: [],
  stagedAnswers: [],
}) as ComposerDraft;

const KEY_PREFIX = 'atlas.composer.draft.';
const storageKey = (jobId: string): string => `${KEY_PREFIX}${jobId}`;

/** Debounce window for a sessionStorage write — long enough to skip per-keystroke writes, short enough
 *  that a draft is safely on disk before a realistic reload. */
const PERSIST_DEBOUNCE_MS = 300;

/** Debounce window for the server autosave (`PUT .../draft`) — idle-based, coarser than the sessionStorage
 *  write so a burst of keystrokes settles into a single round-trip. */
const DRAFT_AUTOSAVE_MS = 500;

interface PersistedDraft {
  ref: JobRef;
  text: string;
  comments: ReviewComment[];
  outbox: Array<Pick<QueuedMessage, 'id' | 'text' | 'comments' | 'createdAt' | 'hasAttachments'>>;
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
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
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Debounced server-autosave timers (`PUT .../draft`), parallel to `persistTimers`. */
  private readonly autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Jobs whose one-time hydrate-from-server has already been kicked off (guards `ensure`'s per-render call). */
  private readonly hydrated = new Set<string>();
  /** Global (not jobId-keyed) listeners fired on any outbox change — see `subscribeGlobal`. */
  private readonly globalListeners = new Set<() => void>();

  constructor() {
    if (hasWindow() && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => this.flushAll());
      // Reconnect reconciliation: on an offline→online transition re-send every dirty draft (idempotent
      // last-write-wins) and re-pull each open job to fold in edits from other devices missed while offline.
      connectivity.subscribe(() => {
        if (connectivity.getSnapshot() === 'online') this.onReconnect();
      });
    }
  }

  private notify(jobId: string): void {
    this.entries.get(jobId)?.listeners.forEach((l) => l());
  }

  /**
   * Subscribe to ANY outbox change across every Job (not keyed by jobId). `<OutboxFlusher>` uses this to
   * attempt a drain when the Composer's mid-flight fallback re-enqueues a message while connectivity is
   * still "online" — a sub-RECONNECTING_AFTER_MS blip that self-heals via `probe()` never flips the
   * connectivity status, so the flusher's status-transition path never fires for it.
   */
  subscribeGlobal(cb: () => void): () => void {
    this.globalListeners.add(cb);
    return () => {
      this.globalListeners.delete(cb);
    };
  }

  private notifyGlobal(): void {
    this.globalListeners.forEach((l) => l());
  }

  /** Create + hydrate an entry for `ref.jobId` if absent (idempotent — safe to call on every render).
   *  A blank jobId is the ref-less sentinel (create-job modal) — it owns no draft, so ignore it. */
  ensure(ref: JobRef): void {
    if (!ref.jobId) return;
    if (this.entries.has(ref.jobId)) {
      this.hydrateFromServer(ref); // idempotent — the guard inside runs the fetch at most once per job
      return;
    }
    const persisted = readPersisted(ref.jobId);
    const state: ComposerDraft = {
      ref,
      text: persisted?.text ?? '',
      attachments: [],
      comments: persisted?.comments ?? [],
      stagedAnswers: [],
      // A queued item with neither text, comments, nor staged attachments has nothing to send — drop it
      // rather than leave a dead entry the flusher would silently discard.
      outbox: (persisted?.outbox ?? [])
        .map((q) => ({
          ...q,
          createdAt: q.createdAt ?? Date.now(),
          hasAttachments: q.hasAttachments ?? false,
        }))
        .filter((q) => q.text || q.comments.length > 0 || q.hasAttachments),
    };
    this.entries.set(ref.jobId, {
      state,
      listeners: new Set(),
      lastLocalEditAt: 0,
      dirty: false,
      pendingDeletes: new Set(),
    });
    this.hydrateFromServer(ref);
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
        state: {
          ...EMPTY,
          attachments: [],
          comments: [],
          outbox: [],
          stagedAnswers: [],
        },
        listeners: new Set(),
        lastLocalEditAt: 0,
        dirty: false,
        pendingDeletes: new Set(),
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
    this.markEdited(ref.jobId);
  }

  setComments(ref: JobRef, updater: (prev: ReviewComment[]) => ReviewComment[]): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).comments;
    this.replace(ref, { comments: updater(prev) });
    this.schedulePersist(ref.jobId);
    this.markEdited(ref.jobId);
  }

  setAttachments(ref: JobRef, updater: (prev: DraftAttachment[]) => DraftAttachment[]): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).attachments;
    // Attachments upload on-add to the server (not via the debounced draft autosave), so no persist/
    // markEdited here — the array is a reflection of server rows, driven by `use-attachments`.
    this.replace(ref, { attachments: updater(prev) });
  }

  /** Delete one uploaded draft attachment. Tracked in `pendingDeletes` until confirmed so a failed request
   *  (or one attempted while offline) is retried on reconnect instead of silently orphaning the server row
   *  — mirrors `dirty`'s retry of the draft-body autosave. */
  deleteAttachment(ref: JobRef, attachmentId: string): void {
    this.ensure(ref);
    this.entries.get(ref.jobId)?.pendingDeletes.add(attachmentId);
    this.tryDeleteAttachment(ref, attachmentId);
  }

  private tryDeleteAttachment(ref: JobRef, attachmentId: string): void {
    if (connectivity.getSnapshot() !== 'online') return; // left pending — reconnect retries it
    void deleteDraftAttachment(ref, attachmentId)
      .then(() => {
        this.entries.get(ref.jobId)?.pendingDeletes.delete(attachmentId);
      })
      .catch(() => {
        // Transient failure — stays in `pendingDeletes` so the next reconnect retries.
      });
  }

  setStagedAnswers(ref: JobRef, updater: (prev: StagedAnswer[]) => StagedAnswer[]): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).stagedAnswers;
    this.replace(ref, { stagedAnswers: updater(prev) });
    this.markEdited(ref.jobId);
  }

  /** Stage (or re-stage) one card's answer — upserts by `cardId` so re-answering the same card replaces its
   *  prior staged entry rather than duplicating it. */
  stageAnswer(ref: JobRef, answer: StagedAnswer): void {
    this.setStagedAnswers(ref, (prev) => [
      ...prev.filter((a) => a.cardId !== answer.cardId),
      answer,
    ]);
  }

  /** Drop one staged answer (the tray's remove `X`, or a card's own "Remove" reverting it to answerable). */
  removeStagedAnswer(ref: JobRef, cardId: string): void {
    this.setStagedAnswers(ref, (prev) => prev.filter((a) => a.cardId !== cardId));
  }

  /** Flip `submitting` on the staged answers matching `cardIds` — set true the instant Send is hit (so the
   *  tray hides them without removing them, and the card can show a "sending…" shell), reverted to false on
   *  a failed send so the tray/card fall back to their staged state for retry. */
  markSubmitting(ref: JobRef, cardIds: string[], submitting: boolean): void {
    const ids = new Set(cardIds);
    this.setStagedAnswers(ref, (prev) =>
      prev.map((a) => (ids.has(a.cardId) ? { ...a, submitting } : a)),
    );
  }

  /**
   * Drop any staged answer whose card has gone stale — withdrawn by the brain, or already answered/
   * provided (e.g. from another tab) — since it was staged, so the tray can't submit a dead card. Called on
   * every `threadMessages` refetch. A card with NO match in `messages` is KEPT (the message list may be
   * paginated/incomplete, so absence isn't evidence the card is gone).
   */
  pruneStagedAnswers(ref: JobRef, messages: JobMessage[]): void {
    const entry = this.entries.get(ref.jobId);
    if (!entry) return;
    const prev = entry.state.stagedAnswers;
    const next = prev.filter((a) => !isStagedAnswerStale(a, messages));
    if (next.length === prev.length) return; // no-op guard, avoid churn on every refetch
    this.replace(ref, { stagedAnswers: next });
    this.markEdited(ref.jobId);
  }

  setOutbox(ref: JobRef, updater: (prev: QueuedMessage[]) => QueuedMessage[]): void {
    this.ensure(ref);
    const prev = this.getDraft(ref.jobId).outbox;
    this.replace(ref, { outbox: updater(prev) });
    this.schedulePersist(ref.jobId);
    this.notifyGlobal();
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
      text: '',
      attachments: [],
      comments: [],
    };
    this.notify(jobId);
    this.persistNow(jobId, entry.state);
    // Push the cleared body to the server too. The /message send-path clears the draft server-side (this
    // is then an idempotent no-op echo); the /review-comments path does not, so this is what syncs the
    // reset across the operator's other devices.
    this.markEdited(jobId);
  }

  /** Record a local edit (the last-write-wins clock) and schedule a debounced server autosave. */
  private markEdited(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    entry.lastLocalEditAt = Date.now();
    entry.dirty = true;
    this.scheduleAutosave(jobId);
  }

  private scheduleAutosave(jobId: string): void {
    const existing = this.autosaveTimers.get(jobId);
    if (existing) clearTimeout(existing);
    this.autosaveTimers.set(
      jobId,
      setTimeout(() => {
        this.autosaveTimers.delete(jobId);
        void this.pushDraft(jobId);
      }, DRAFT_AUTOSAVE_MS),
    );
  }

  /** PUT the job's current draft body. While offline it's a no-op — the `dirty` flag holds and a reconnect
   *  re-sends. Clears `dirty` only if no newer edit slipped in during the round-trip. Returns a promise that
   *  always resolves (never rejects) once the attempt has settled, so callers (e.g. `onReconnect`) can
   *  sequence a follow-up GET after this PUT lands rather than racing it. */
  private pushDraft(jobId: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (!entry) return Promise.resolve();
    if (connectivity.getSnapshot() !== 'online') return Promise.resolve();
    const { ref, text, stagedAnswers, comments } = entry.state;
    const stamp = entry.lastLocalEditAt;
    return putDraft(ref, { text, stagedAnswers, comments })
      .then(() => {
        const cur = this.entries.get(jobId);
        if (cur && cur.lastLocalEditAt === stamp) cur.dirty = false;
      })
      .catch(() => {
        // Transient failure — keep `dirty` so the next reconnect re-sends.
      });
  }

  /** One-time hydrate from the server draft (server wins over the sessionStorage fallback paint). Guarded
   *  so `ensure`'s per-render call fetches at most once per job; a failed fetch reopens the guard so a
   *  reconnect retries. */
  private hydrateFromServer(ref: JobRef): void {
    if (!ref.jobId || this.hydrated.has(ref.jobId)) return;
    this.hydrated.add(ref.jobId);
    this.fetchAndReconcile(ref, () => this.hydrated.delete(ref.jobId));
  }

  /** GET the server draft and fold it in UNLESS a local edit happened during the fetch (in-flight LWW —
   *  used where no server `updatedAt` is available, i.e. hydrate + reconnect resync). */
  private fetchAndReconcile(ref: JobRef, onError?: () => void): void {
    const entry = this.entries.get(ref.jobId);
    if (!entry) return;
    const stamp = entry.lastLocalEditAt;
    void getDraft(ref)
      .then(({ payload, attachments }) => {
        const cur = this.entries.get(ref.jobId);
        if (!cur || cur.lastLocalEditAt !== stamp) return; // a local edit raced the fetch — keep it
        this.applyPayload(ref.jobId, payload, attachments);
      })
      .catch(() => onError?.());
  }

  /** Realtime told us this job's server draft changed at `updatedAtMs` — refetch the real payload (never
   *  carried on the WAL) and reconcile it under last-write-wins against `updatedAtMs`. */
  pullServerDraft(jobId: string, updatedAtMs: number): void {
    const ref = this.entries.get(jobId)?.state.ref;
    if (!ref) return; // not a job the operator has open — nothing local to reconcile
    void getDraft(ref)
      .then(({ payload, attachments }) => {
        this.applyServerPayload(jobId, payload, attachments, updatedAtMs);
      })
      .catch(() => {});
  }

  /** Fold a server payload in unless a fresher UNSYNCED local edit exists (its clock beats `updatedAt`). */
  applyServerPayload(
    jobId: string,
    payload: DraftPayloadWire,
    attachments: DraftAttachmentDto[],
    updatedAt: number,
  ): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    if (entry.lastLocalEditAt > updatedAt) return; // our own newer edit is in flight — don't clobber it
    this.applyPayload(jobId, payload, attachments);
  }

  /** Replace the server-backed slices from a payload (does NOT touch the LWW clock / dirty flag). */
  private applyPayload(
    jobId: string,
    payload: DraftPayloadWire,
    attachments: DraftAttachmentDto[],
  ): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    const existingById = new Map(entry.state.attachments.map((a) => [a.id, a]));
    const nextAttachments = attachments
      .filter((a) => !entry.pendingDeletes.has(a.id))
      .map((a) => {
        const existing = existingById.get(a.id);
        return {
          id: a.id,
          name: a.name,
          kind: a.kind,
          size: a.size,
          ...(existing?.url ? { url: existing.url } : {}),
        };
      });
    const nextIds = new Set(nextAttachments.map((a) => a.id));
    const stillUploading = entry.state.attachments.filter((a) => a.pending && !nextIds.has(a.id));
    entry.state = {
      ...entry.state,
      text: payload.text,
      stagedAnswers: payload.stagedAnswers,
      comments: payload.comments,
      attachments: [...nextAttachments, ...stillUploading],
    };
    this.notify(jobId);
    this.persistNow(jobId, entry.state); // keep the sessionStorage fallback buffer in sync
  }

  /** The full `JobRef` for an open job (the realtime row carries only jobId/orgId). */
  getRef(jobId: string): JobRef | null {
    return this.entries.get(jobId)?.state.ref ?? null;
  }

  private onReconnect(): void {
    for (const [jobId, entry] of this.entries) {
      if (!jobId) continue;
      for (const id of entry.pendingDeletes) this.tryDeleteAttachment(entry.state.ref, id);
      if (entry.dirty) {
        // Reconnect conflict check: server wins if it changed after our last local edit; otherwise push the
        // dirty local body, then refetch so this device carries the server's canonical timestamps/attachments.
        void getDraft(entry.state.ref)
          .then(({ payload, attachments, updatedAt }) => {
            const cur = this.entries.get(jobId);
            if (!cur) return;
            const parsed = updatedAt ? Date.parse(updatedAt) : 0;
            const serverUpdatedAt = Number.isFinite(parsed) ? parsed : 0;
            if (cur.lastLocalEditAt <= serverUpdatedAt) {
              cur.dirty = false;
              this.applyPayload(jobId, payload, attachments);
              return;
            }
            void this.pushDraft(jobId).then(() => this.fetchAndReconcile(cur.state.ref));
          })
          .catch(() => {
            void this.pushDraft(jobId);
          });
      } else {
        this.fetchAndReconcile(entry.state.ref);
      }
    }
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

  /** Synchronously persist one Job's current draft/outbox, cancelling any pending debounced write. */
  flushDraft(jobId: string): void {
    if (!jobId) return;
    this.persistNow(jobId, this.entries.get(jobId)?.state ?? null);
  }

  /** Synchronously persist every touched Job. Used on `pagehide` so a recent keystroke survives reload. */
  flushAll(): void {
    const jobIds = new Set([...this.entries.keys(), ...this.persistTimers.keys()]);
    for (const jobId of jobIds) this.flushDraft(jobId);
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
    const text = state?.text ?? '';
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
          hasAttachments: q.hasAttachments,
        })),
      };
      window.sessionStorage.setItem(storageKey(jobId), JSON.stringify(persisted));
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
        if (key?.startsWith(KEY_PREFIX)) jobIds.push(key.slice(KEY_PREFIX.length));
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

/**
 * Whether a staged answer's card has already gone stale (withdrawn, or answered/provided by another tab)
 * since it was staged. Matches by the card's own kind + id (`questionId`/`requestId`) against `cardId`; a
 * card that isn't found at all in `messages` is NOT stale — the list may be paginated/incomplete.
 */
function isStagedAnswerStale(answer: StagedAnswer, messages: JobMessage[]): boolean {
  for (const m of messages) {
    const card = m.card;
    if (!card) continue;
    if (
      answer.kind === 'question' &&
      card.type === 'question_card' &&
      card.questionId === answer.cardId
    ) {
      return card.withdrawnAt != null || card.answer != null;
    }
    if (
      answer.kind === 'file' &&
      card.type === 'file_request_card' &&
      card.requestId === answer.cardId
    ) {
      return card.withdrawnAt != null || card.provided_at != null;
    }
    if (
      answer.kind === 'secret' &&
      card.type === 'secret_input_card' &&
      card.requestId === answer.cardId
    ) {
      return card.withdrawnAt != null || card.provided_at != null;
    }
  }
  return false;
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
  const getSnapshot = useCallback(() => composerStore.getDraft(ref.jobId), [ref.jobId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/**
 * Slice-aware subscriptions — `attachments` / `comments` only. `replace` spreads the untouched arrays, so a
 * draft's `attachments` and `comments` refs are PRESERVED across a text edit; a `getSnapshot` that returns
 * just that array is therefore stable under keystrokes (Object.is holds) and `useSyncExternalStore` skips the
 * re-render. This keeps the transcript pane (via `useAttachments`) and the review-comments provider off the
 * per-keystroke render path — only the Composer's own text subscription re-renders while typing.
 */
export function useComposerAttachments(ref: JobRef): DraftAttachment[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(() => composerStore.getDraft(ref.jobId).attachments, [ref.jobId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.attachments);
}

export function useComposerComments(ref: JobRef): ReviewComment[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(() => composerStore.getDraft(ref.jobId).comments, [ref.jobId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.comments);
}

/** Slice-aware subscription — a Job's staged-answers tray only, so `<StagedAnswersTray>` and each card's
 *  compact "staged" state re-render on stage/remove without subscribing to text/attachments/comments. */
export function useComposerStagedAnswers(ref: JobRef): StagedAnswer[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(
    () => composerStore.getDraft(ref.jobId).stagedAnswers,
    [ref.jobId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.stagedAnswers);
}

 *  removeQueued without subscribing to text/attachments/comments changes. Same pattern as `useComposerComments`. */
export function useOutbox(ref: JobRef): QueuedMessage[] {
  composerStore.ensure(ref);
  const subscribe = useCallback(
    (cb: () => void) => composerStore.subscribe(ref.jobId, cb),
    [ref.jobId],
  );
  const getSnapshot = useCallback(() => composerStore.getDraft(ref.jobId).outbox, [ref.jobId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY.outbox);
}
