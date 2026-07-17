import { refreshSession } from "@/lib/api/refresh";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { SseOpener } from "@workspace/pg-realtime/rtk";

/**
 * Auth-aware SSE opener for pg-realtime's `streamList`/`streamDocument`. Credentialed (cookie
 * session), transparently reauths on a 401 (single-flight `refreshSession()` then reconnect), and
 * reconnects with jittered backoff on transient failures / server-side stream close. A definitive
 * 401 (refresh failed) or a 4xx other than 429 is fatal and stops the stream; the RTK cache-entry
 * lifecycle aborts it via `init.signal` when the query unmounts.
 */
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const JITTER_MS = 500;

class RetriableSseError extends Error {}
class FatalSseError extends Error {}

export const sseOpener: SseOpener = (url, init) => {
  let attempts = 0;

  return fetchEventSource(url, {
    signal: init.signal,
    openWhenHidden: init.openWhenHidden ?? true,
    credentials: "include",

    async onopen(res) {
      const contentType = res.headers.get("content-type") ?? "";
      if (res.ok && contentType.includes("text/event-stream")) {
        attempts = 0; // healthy connection — reset backoff
        return;
      }
      if (res.status === 401) {
        const refreshed = await refreshSession();
        throw refreshed
          ? new RetriableSseError("reauthenticated")
          : new FatalSseError("unauthorized");
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new FatalSseError(`SSE rejected (${res.status})`);
      }
      throw new RetriableSseError(`SSE unavailable (${res.status})`);
    },

    onmessage(ev) {
      // A pg-realtime `error` event is a server-signalled fatal condition.
      if (ev.event === "error") throw new FatalSseError(ev.data || "stream error");
      init.onmessage({ event: ev.event, data: ev.data });
    },

    onclose() {
      // The server closed the stream (e.g. deploy/rollover) — reconnect.
      throw new RetriableSseError("stream closed");
    },

    onerror(err) {
      if (err instanceof FatalSseError) throw err; // propagate → stop
      init.onerror?.(err);
      attempts += 1;
      return Math.min(BASE_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS) + Math.random() * JITTER_MS;
    },
  });
};
