"use client";

import { useCallback, useSyncExternalStore } from "react";
import { env } from "@/lib/env";
import { IDLE_LINGER_MS, subscribeSse } from "./sse-manager";
import { fetchServiceLogTail, type JobRef } from "./job-api";

/**
 * LIVE service-log store — the SSE-tailed content of one `atlas-svc`-supervised process's log.
 *
 * Content lives here, in a module-level cache, rather than in the viewing component's own state. The
 * shared `sse-manager` (see `subscribeSse`) keeps an idle connection alive for `IDLE_LINGER_MS` after the
 * last subscriber detaches, and re-attaching to an already-open connection within that window does NOT
 * get a fresh server `snapshot` (see `sse-manager.ts`'s `add()` — it just fires `onOpen` synchronously).
 * If the log content lived in component state, a remount inside that window (tab re-focus, React
 * StrictMode, a quick pane close/reopen) would start blank and only catch subsequent `append` frames,
 * silently dropping everything already streamed. Caching it here means a remount inside the window reads
 * the still-cached content, and a remount past it gets a genuinely fresh connection + a fresh `snapshot`
 * from the server. Mirrors the `ThreadStreamStore` pattern in `job-stream.ts` (module `Map` + per-key
 * listeners + `useSyncExternalStore`).
 *
 * One hole the cache alone can't cover: the two grace windows are STACKED, not aligned. This store's
 * release fires `IDLE_LINGER_MS` after the last viewer leaves, and only THEN does the sse-manager start
 * its own `IDLE_LINGER_MS` idle countdown before the socket actually closes. A re-open landing in that
 * second window finds no cached entry but DOES find the still-open connection — a `'late-join'`, which
 * never gets the server's `snapshot` frame (it's only emitted on a real connection open) — so a fresh
 * entry would sit blank forever on a quiet service. `onOpen('late-join')` on a fresh entry is exactly
 * that signature, and we recover by fetching the same tail over REST (see `restCatchUp`).
 */

export interface ServiceLogState {
  content: string;
  truncated: boolean;
}

interface Entry {
  /** Replaced (never mutated) on every update — `useSyncExternalStore` needs a stable ref between changes. */
  state: ServiceLogState;
  unsub: () => void;
  listeners: Set<() => void>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  /** True once a real SSE `snapshot` frame has arrived — gates the late-join REST catch-up (see `restCatchUp`). */
  sawSnapshot: boolean;
}

interface LogFrame {
  type?: "snapshot" | "append";
  content?: string;
  truncated?: boolean;
  chunk?: string;
}

const key = (ref: JobRef, id: string): string =>
  `${ref.orgId}:${ref.repoId}:${ref.jobId}:${id}`;
const url = (ref: JobRef, id: string): string =>
  `${env.NEXT_PUBLIC_BACKEND_URL}/web/orgs/${ref.orgId}/repos/${ref.repoId}/jobs/${ref.jobId}/services/${encodeURIComponent(id)}/log-events`;

/**
 * Cap on the client-side buffer, in LINES. Without this, a long-running chatty service would grow this
 * string forever for the life of the tab — every `append` re-concatenates it, and the view re-splits the
 * whole thing into lines on every update (see `service-log-view.tsx`). Bounding it keeps both O(cap), not
 * O(total session history). 5000 lines is generous scrollback while staying cheap to re-split on every tick.
 */
const MAX_CLIENT_LINES = 5_000;

/**
 * Drop lines off the FRONT once `content` exceeds `maxLines`. Scans backward from the end and stops as
 * soon as it's found the cut point, so this is O(maxLines), not O(content.length) — it never re-walks the
 * (already-capped) history that's about to be discarded anyway.
 */
function capLines(
  content: string,
  maxLines: number,
): { content: string; trimmed: boolean } {
  let newlines = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content.charCodeAt(i) !== 10 /* \n */) continue;
    newlines++;
    if (newlines > maxLines)
      return { content: content.slice(i + 1), trimmed: true };
  }
  return { content, trimmed: false };
}

class ServiceLogStore {
  private readonly entries = new Map<string, Entry>();

  private notify(k: string): void {
    this.entries.get(k)?.listeners.forEach((l) => l());
  }

  private onFrame(k: string, data: string): void {
    let frame: LogFrame;
    try {
      frame = JSON.parse(data) as LogFrame;
    } catch {
      return;
    }
    const entry = this.entries.get(k);
    if (!entry) return;
    if (frame.type === "snapshot") {
      entry.sawSnapshot = true;
      entry.state = {
        content: frame.content ?? "",
        truncated: Boolean(frame.truncated),
      };
    } else if (frame.type === "append" && frame.chunk) {
      const capped = capLines(
        entry.state.content + frame.chunk,
        MAX_CLIENT_LINES,
      );
      entry.state = {
        content: capped.content,
        truncated: entry.state.truncated || capped.trimmed,
      };
    } else {
      return;
    }
    this.notify(k);
  }

  /** Add a listener for `k`, opening the SSE connection on the first one. Returns the detach fn. */
  subscribe(ref: JobRef, id: string, cb: () => void): () => void {
    const k = key(ref, id);
    let entry = this.entries.get(k);
    if (!entry) {
      const unsub = subscribeSse(url(ref, id), {
        onFrame: (data) => this.onFrame(k, data),
        // A fresh entry late-joining an already-open connection (the previous entry released, but the
        // socket is still in the sse-manager's own linger) will never receive a `snapshot` frame — the
        // stacked-grace-window hole described above. Recover the tail over REST.
        onOpen: (_h, kind) => {
          if (kind === "late-join") void this.restCatchUp(k, ref, id);
        },
      });
      entry = {
        state: { content: "", truncated: false },
        unsub,
        listeners: new Set(),
        releaseTimer: null,
        sawSnapshot: false,
      };
      this.entries.set(k, entry);
    } else if (entry.releaseTimer) {
      // A pending release from a just-departed last listener — this new subscriber cancels it, reusing
      // the still-open connection AND the content accumulated so far (the whole point of this cache).
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.listeners.add(cb);
    return () => this.detach(k, cb);
  }

  /**
   * Late-join catch-up: fetch the same tail the SSE `snapshot` frame would have carried, over REST.
   * Applied only if no real snapshot arrived meanwhile (the connection may have reconnected in the gap —
   * a genuine snapshot is fresher and must win). Replacing the whole content is safe against appends that
   * streamed in before this resolves: the REST read happens after they hit the file, so it includes them.
   */
  private async restCatchUp(k: string, ref: JobRef, id: string): Promise<void> {
    let tail: { content: string; truncated: boolean };
    try {
      tail = await fetchServiceLogTail(ref, id);
    } catch {
      return; // transient fetch failure — the view stays on whatever the stream delivers
    }
    const entry = this.entries.get(k);
    if (!entry || entry.sawSnapshot) return;
    entry.sawSnapshot = true;
    entry.state = { content: tail.content, truncated: tail.truncated };
    this.notify(k);
  }

  private detach(k: string, cb: () => void): void {
    const entry = this.entries.get(k);
    if (!entry) return;
    entry.listeners.delete(cb);
    if (entry.listeners.size > 0 || entry.releaseTimer) return;
    entry.releaseTimer = setTimeout(() => {
      const cur = this.entries.get(k);
      if (!cur || cur.listeners.size > 0) return; // re-subscribed during the grace window
      cur.unsub();
      this.entries.delete(k);
    }, IDLE_LINGER_MS);
  }

  getState(ref: JobRef, id: string): ServiceLogState | undefined {
    return this.entries.get(key(ref, id))?.state;
  }
}

const store = new ServiceLogStore();

/** Subscribe to one supervised process's live-tailed log. */
export function useServiceLogStream(
  ref: JobRef,
  id: string,
): ServiceLogState | undefined {
  const subscribe = useCallback(
    (cb: () => void) => store.subscribe(ref, id, cb),
    [ref.orgId, ref.repoId, ref.jobId, id],
  );
  const getSnapshot = useCallback(
    () => store.getState(ref, id),
    [ref.orgId, ref.repoId, ref.jobId, id],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}
