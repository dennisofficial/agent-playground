"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  connectivity,
  useConnectivity,
  type ConnectivityStatus,
} from "@/lib/api/connectivity";
import { composerStore } from "@/lib/api/composer-store";
import {
  postReviewComments,
  sayMessage,
  sayMessageWithFiles,
} from "@/lib/api/job-api";
import { qk } from "@/lib/api/query-keys";

/**
 * App-level auto-send flusher for the offline-send outbox — mounted once in `<AppChrome>` (renders
 * nothing). Drains `composerStore.allQueued()` FIFO (global order across every Job, not just the active
 * one) whenever connectivity reaches "online": on a live reconnect (status transition) AND once on mount
 * if already "online" — the latter is what drains outboxes `restorePersistedOutboxes()` rehydrated from
 * sessionStorage after a reload, where no transition ever fires because connectivity starts "online".
 *
 * Precedence per item mirrors the Composer's `send()` exactly: comments → attachments → text.
 */
export function OutboxFlusher(): null {
  const status = useConnectivity();
  const qc = useQueryClient();
  const prevStatus = useRef<ConnectivityStatus | null>(null);
  const isFlushing = useRef(false);

  useEffect(() => {
    const wasOnline = prevStatus.current === "online";
    prevStatus.current = status;
    if (status !== "online" || wasOnline) return;
    void flush();

    async function flush() {
      if (isFlushing.current) return;
      isFlushing.current = true;
      try {
        for (const { ref, msg } of composerStore.allQueued()) {
          // Dropped again mid-flush — stop and leave the rest queued for the next reconnect.
          if (connectivity.getSnapshot() !== "online") break;
          try {
            if (msg.comments.length > 0) {
              await postReviewComments(ref, {
                items: msg.comments.map((c) => ({
                  file: c.file.label,
                  quote: c.quote,
                  note: c.note || undefined,
                })),
                message: msg.text || undefined,
              });
            } else if (msg.attachments.length > 0) {
              await sayMessageWithFiles(
                ref,
                msg.text,
                msg.attachments.map((a) => a.file),
              );
            } else if (msg.text) {
              await sayMessage(ref, msg.text);
            } else {
              // Empty (shouldn't happen post-hydrate filter) — nothing to send, discard.
              composerStore.removeQueued(ref.jobId, msg.id);
              continue;
            }
            composerStore.removeQueued(ref.jobId, msg.id);
            void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
          } catch {
            // Network hiccup mid-flush — stop here; the next online transition retries from this item.
            break;
          }
        }
      } finally {
        isFlushing.current = false;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush reads composerStore/connectivity directly (module singletons), not via props/state
  }, [status]);

  return null;
}
