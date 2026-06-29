'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { env } from '@/lib/env';
import { qk } from './query-keys';
import { subscribeSse } from './sse-manager';
import type { InboxThread } from './inbox';
import type { ThreadRef } from './thread-api';
import { applyStreamFrame, endLiveTurn } from './thread-stream';
import { clearQueuedSends } from './queued-sends';

/** A frame off the repo SSE: a durable-post change-signal, a live engine-stream frame, or a meta update. */
interface SseFrame {
  type?: string;
  threadId?: string;
  /** Which turn lane this stream frame belongs to: `'main'` (the brain) or `'phase:<stepId>'` (a build). */
  lane?: string;
  seq?: number;
  event?: { kind?: string; name?: string; input?: { file_path?: string } };
  /** `thread_meta` frame: the new thread title (e.g. an auto-generated one). */
  title?: string;
}

/**
 * In-turn `/context` freshness: the brain authors `specs/` (and `artifacts/`) files DURING a turn via its
 * standard Write/Edit tools, but durable messages only persist at `turn_end` — so the SPECS/GENERATED/
 * ARTIFACTS listing would otherwise sit stale until the turn finishes. The `tool_use` engine events
 * already stream live, carrying the `file_path` being written, so we refetch the context listing the
 * moment a context file is touched. (Bash-based writes — echo/sed — don't surface as a Write tool_use and
 * are not covered here; they settle on the next `message`/`turn_end` reconcile.)
 */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CONTEXT_WRITE_RE = /\/context\/(specs|generated|artifacts)\//;

/**
 * Live updates for the open thread. The repo-scoped SSE (`…/repos/:repoId/events`) carries two frame
 * types (discriminated by `type`):
 *
 *  - `{ type: 'message', … }` — a durable post landed (chat / approval card / PR / status). Used as a
 *    CHANGE-SIGNAL: debounced-refetch the open thread's messages + pipeline (the authoritative,
 *    threadId-scoped reads). A sibling thread's activity also triggers a refetch — fine for an operator
 *    console.
 *  - `{ type: 'stream', threadId, event }` — a LIVE engine-stream frame (token deltas, thinking, tool
 *    calls/results, and a `turn_end` marker) for the in-sandbox session. Filtered to the OPEN thread and
 *    fed into the live-turn store (`thread-stream.ts`); on `turn_end` we refetch `/messages` (now holding
 *    the persisted blocks) and THEN clear the live buffer (no flicker).
 *
 * Resilience (transient self-heal + a one-shot 401 refresh/reconnect) lives in the shared `sse-manager`.
 *
 * The stream is REPO-scoped, so this hook subscribes per `(orgId, repoId)` — NOT per thread — and reads
 * the currently-open thread from a ref. That keeps ONE standing connection across thread switches within a
 * repo (a thread switch no longer tears the SSE down + reopens it), which is what used to churn the
 * HTTP/1.1 connection pool and stall every fetch in dev.
 */
export function useThreadEvents(ref: ThreadRef): void {
  const qc = useQueryClient();
  const { orgId, repoId, threadId } = ref;

  // The open thread, read live by the frame handlers — so the standing subscription always targets the
  // CURRENT thread without re-subscribing when it changes.
  const openThreadRef = useRef(threadId);
  openThreadRef.current = threadId;

  useEffect(() => {
    if (!orgId || !repoId) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let ctxDebounce: ReturnType<typeof setTimeout> | null = null;

    // Built from the open thread at call time (not captured once) so the standing connection's debounced
    // invalidations always target whichever thread is open now.
    const liveRef = (): ThreadRef => ({ orgId, repoId, threadId: openThreadRef.current });
    // The 4-element prefix matches every open `/context` file for a thread (the 5th element is the path).
    const contextFilesKey = (r: ThreadRef) => qk.threadContextFile(r, '').slice(0, 4);

    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const r = liveRef();
        void qc.invalidateQueries({ queryKey: qk.threadMessages(r) });
        void qc.invalidateQueries({ queryKey: qk.threadPipeline(r) });
        void qc.invalidateQueries({ queryKey: qk.threadContext(r) });
        void qc.invalidateQueries({ queryKey: contextFilesKey(r) });
      }, 250);
    };

    // Context-only refetch (the listing + any open file's contents) — kept separate from `refetch()` so a
    // mid-turn spec write doesn't needlessly churn the messages/pipeline caches.
    const refetchContext = () => {
      if (ctxDebounce) clearTimeout(ctxDebounce);
      ctxDebounce = setTimeout(() => {
        const r = liveRef();
        void qc.invalidateQueries({ queryKey: qk.threadContext(r) });
        void qc.invalidateQueries({ queryKey: contextFilesKey(r) });
      }, 250);
    };

    const reconcileNow = (r: ThreadRef) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.threadMessages(r) }),
        qc.invalidateQueries({ queryKey: qk.threadPipeline(r) }),
        qc.invalidateQueries({ queryKey: qk.threadContext(r) }),
        qc.invalidateQueries({ queryKey: contextFilesKey(r) }),
      ]);

    const onFrame = (data: string) => {
      let frame: SseFrame | null = null;
      try {
        frame = JSON.parse(data) as SseFrame;
      } catch {
        refetch(); // unparseable → fall back to a change-signal refetch
        return;
      }
      if (frame?.type === 'stream') {
        // The repo stream carries the live turn for EVERY thread in the repo. We feed them ALL into the
        // (thread-keyed) live-turn store — NOT just the open thread — so switching to a sibling thread that
        // is mid-stream is instant, with its already-streamed output present. (Before, this connection
        // re-opened per thread to re-trigger the snapshot; now it stands, so we must not drop siblings.)
        const fThread = frame.threadId;
        if (!fThread) return;
        // Which lane (the brain `main` turn, or a `phase:<stepId>` build turn). Lanes are independent
        // in-flight turns on the same thread; the conversation reads `main`, the step sub-page reads its phase.
        const lane = frame.lane ?? 'main';
        if (frame.event?.kind === 'turn_end') {
          // Reconcile: refetch durable messages, THEN clear THIS lane's live buffer (so no gap/flicker). The
          // queued-sends tags belong to the brain's serialized queue, so only the `main` turn ending clears
          // them; a build (phase) turn ending must not drop a follow-up the operator queued for the brain.
          // For a non-open thread the invalidations just mark its (unobserved) queries stale — no fetch.
          void reconcileNow({ orgId, repoId, threadId: fThread }).then(() => {
            endLiveTurn(fThread, lane);
            if (lane === 'main') clearQueuedSends(fThread);
          });
        } else {
          // Snapshot (catch-up on connect) or a live delta — both deduped by seq in the store, per lane.
          applyStreamFrame(fThread, lane, frame.seq ?? 0, frame.event);
          // In-turn freshness for the OPEN thread only: the brain just wrote a `/context` file via Write/Edit
          // → refresh the SPECS/GENERATED/ARTIFACTS listing now, instead of waiting for the durable reconcile.
          const ev = frame.event;
          if (
            fThread === openThreadRef.current &&
            ev?.kind === 'tool_use' &&
            ev.name != null &&
            FILE_WRITE_TOOLS.has(ev.name) &&
            ev.input?.file_path != null &&
            CONTEXT_WRITE_RE.test(ev.input.file_path)
          ) {
            refetchContext();
          }
        }
        return;
      }
      if (frame?.type === 'ticket_event') {
        // A board mutation on this repo (often Atlas capturing a ticket mid-conversation) — keep the
        // tickets caches fresh so the board reflects it the moment the operator switches to it.
        void qc.invalidateQueries({ queryKey: qk.ticketsList(orgId, repoId) });
        void qc.invalidateQueries({ queryKey: ['ticket-detail', orgId, repoId] });
        return;
      }
      if (frame?.type === 'thread_meta' && frame.threadId && frame.title) {
        // A thread title changed (e.g. the auto-generated one). Patch the inbox cache in place — the
        // sidebar AND the navigator header both read the title from `allThreads` — then invalidate as a
        // backstop. (The navigator/sidebar update live; no message frame is involved in titling.)
        const { threadId: id, title } = frame;
        qc.setQueryData<InboxThread[]>(qk.allThreads(), (prev) =>
          prev?.map((t) => (t.id === id ? { ...t, title } : t)),
        );
        void qc.invalidateQueries({ queryKey: qk.allThreads() });
        return;
      }
      // `{ type: 'message' }` (or any non-stream frame) — a durable post landed → change-signal refetch.
      refetch();
    };

    // Catch a title generated before this stream subscribed: pull the durable title from `allThreads` on
    // every (re)connect (a `thread_meta` frame could have fired during the connect gap).
    const onOpen = () => void qc.invalidateQueries({ queryKey: qk.allThreads() });

    const url = `${env.NEXT_PUBLIC_HTTP_URL}/web/orgs/${orgId}/repos/${repoId}/events`;
    const unsubscribe = subscribeSse(url, { onFrame, onOpen });
    return () => {
      if (debounce) clearTimeout(debounce);
      if (ctxDebounce) clearTimeout(ctxDebounce);
      unsubscribe();
    };
  }, [orgId, repoId, qc]);
}
