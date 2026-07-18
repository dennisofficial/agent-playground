'use client';

import { useQueryClient } from '@/lib/api/_tanstack-shim';
import { composerStore } from '@/lib/api/composer-store';
import { connectivity, useConnectivity, type ConnectivityStatus } from '@/lib/api/connectivity';
import { postMessage, postReviewComments, ThreadApiError } from '@/lib/api/job-api';
import { qk } from '@/lib/api/query-keys';
import { useCallback, useEffect, useRef } from 'react';

/**
 * App-level auto-send flusher for the offline-send outbox — mounted once in `<AppChrome>` (renders
 * nothing). Drains `composerStore.allQueued()` FIFO (global order across every Job, not just the active
 * one) whenever connectivity reaches "online". It flushes on three triggers:
 *  - a live reconnect (status transition into "online");
 *  - once on mount if already "online" — this is what drains outboxes `restorePersistedOutboxes()`
 *    rehydrated from sessionStorage after a reload, where no transition ever fires because connectivity
 *    starts "online";
 *  - any outbox change while already "online" (`composerStore.subscribeGlobal`) — the Composer's
 *    mid-flight fallback re-enqueues a message when an ONLINE POST hits a network drop that self-heals in
 *    under RECONNECTING_AFTER_MS, so connectivity never leaves "online" and no transition ever fires;
 *    without this the message would sit "Queued — waiting to reconnect" forever while actually online.
 *
 * Precedence per item mirrors the Composer's `send()` exactly: comments → attachments → text.
 */
export function OutboxFlusher(): null {
  const status = useConnectivity();
  const qc = useQueryClient();
  const prevStatus = useRef<ConnectivityStatus | null>(null);
  const isFlushing = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (connectivity.getSnapshot() !== 'online') return;
    if (isFlushing.current) return;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    isFlushing.current = true;
    try {
      for (const { ref, msg } of composerStore.allQueued()) {
        // Dropped again mid-flush — stop and leave the rest queued for the next reconnect.
        if (connectivity.getSnapshot() !== 'online') break;
        try {
          if (msg.comments.length > 0) {
            await postReviewComments(ref, {
              items: msg.comments.map((c) => ({
                file: c.file.label,
                quote: c.quote,
                note: c.note || undefined,
                ...(c.lines ? { lines: c.lines } : {}),
              })),
              message: msg.text || undefined,
            });
          } else if (msg.hasAttachments) {
            // No `files` part — the attachments already live on the server draft (uploaded on-add); the
            // server promotes whatever is still staged onto this message.
            await postMessage(ref, [{ type: 'user', text: msg.text }]);
          } else if (msg.text) {
            await postMessage(ref, [{ type: 'user', text: msg.text }]);
          } else {
            // Empty (shouldn't happen post-hydrate filter) — nothing to send, discard.
            composerStore.removeQueued(ref.jobId, msg.id);
            continue;
          }
          composerStore.removeQueued(ref.jobId, msg.id);
          void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
        } catch (e) {
          // Most `ThreadApiError`s mean the server actually ANSWERED (real 4xx/5xx) — a permanent rejection,
          // not a connectivity drop. The exception is the backend's leader-handoff 503 ("retry momentarily"):
          // keep that item queued and retry shortly, otherwise a restart can make the UI drop an offline send
          // just before the new leader is ready. Only a genuine network error halts the drain without a timer.
          if (e instanceof ThreadApiError) {
            if (e.status === 503) {
              retryTimer.current = setTimeout(() => {
                retryTimer.current = null;
                void flush();
              }, 1500);
              break;
            }
            composerStore.removeQueued(ref.jobId, msg.id);
            continue;
          }
          break;
        }
      }
    } finally {
      isFlushing.current = false;
    }
  }, [qc]);

  // Trigger 1 + 2: a live reconnect (status transition into "online"), and once on mount if already online.
  useEffect(() => {
    const wasOnline = prevStatus.current === 'online';
    prevStatus.current = status;
    if (status !== 'online' || wasOnline) return;
    void flush();
  }, [status, flush]);

  // Trigger 3: outbox changed while already online (mid-flight re-enqueue that never flips status).
  useEffect(
    () =>
      composerStore.subscribeGlobal(() => {
        if (connectivity.getSnapshot() === 'online') void flush();
      }),
    [flush],
  );

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  return null;
}
