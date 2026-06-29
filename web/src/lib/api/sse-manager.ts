'use client';

import { connectivity } from './connectivity';
import { refreshSession } from './refresh';

/**
 * Shared, ref-counted EventSource registry — ONE browser connection per URL, no matter how many hooks
 * subscribe to it.
 *
 * Why this exists: in dev the console talks to the backend over plain HTTP (`http://…:4002`), i.e. HTTP/1.1,
 * where the browser caps ~6 connections per host (shared across ALL tabs of the origin). Every long-lived
 * SSE stream permanently holds one of those slots, so opening the same `/repos/:repoId/events` stream from
 * several hooks — or, worse, re-opening it on every thread switch — could saturate the pool and wedge every
 * REST fetch in a perpetual "Loading…". Centralizing the stream lifecycle here guarantees:
 *   (a) the same URL is never opened twice (dedup across hooks),
 *   (b) thread switches reuse the standing connection instead of tearing it down + reopening, and
 *   (c) the connect / 401-refresh / reconnect resilience lives in exactly ONE place (it used to be
 *       copy-pasted across three hooks).
 *
 * NOTE: this dedups by URL — it does NOT merge *different* endpoints. A workspace tab still holds the
 * cross-org realtime stream AND the open repo's event stream (two distinct URLs = two connections).
 * Collapsing those into one requires a backend change to fold the feeds; this layer removes the churn and
 * the duplicate-URL connections, which is the part that bit on every thread switch.
 */

/** Handle passed to a subscriber's callbacks for stream-level control. */
export interface SseHandle {
  /** Stop this URL's stream for good (no reconnect) until every subscriber has detached. */
  closePermanently(): void;
}

export interface SseSubscriber {
  /** A raw SSE message payload (`MessageEvent.data`). */
  onFrame(data: string, handle: SseHandle): void;
  /**
   * Fired when the underlying connection (re)opens — and immediately on subscribe if it is ALREADY open, so
   * a late joiner still gets its catch-up (e.g. an invalidate-on-connect) without waiting for a reconnect.
   */
  onOpen?(handle: SseHandle): void;
}

/**
 * ms an idle (zero-subscriber) connection lingers before it is actually closed. Absorbs React StrictMode's
 * dev mount→unmount→remount and quick back-to-back navigation so we don't needlessly drop + reopen the
 * socket (which would reintroduce exactly the churn this module exists to remove).
 */
const IDLE_LINGER_MS = 2_000;

class SharedConnection implements SseHandle {
  private es: EventSource | null = null;
  private readonly subs = new Set<SseSubscriber>();
  private refreshedOnce = false;
  /** Set by `closePermanently()` (e.g. the server signalled realtime is disabled) — never reconnect while held. */
  private sealed = false;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly onEmpty: () => void,
  ) {}

  add(sub: SseSubscriber): () => void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.subs.add(sub);
    if (!this.es && !this.sealed) this.connect();
    else if (this.es?.readyState === EventSource.OPEN) sub.onOpen?.(this); // already open → fire catch-up now
    return () => this.remove(sub);
  }

  private remove(sub: SseSubscriber): void {
    this.subs.delete(sub);
    if (this.subs.size > 0 || this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.subs.size > 0) return; // re-subscribed during the linger window → keep the connection
      this.es?.close();
      this.es = null;
      this.onEmpty();
    }, IDLE_LINGER_MS);
  }

  closePermanently(): void {
    this.sealed = true;
    this.es?.close();
    this.es = null;
  }

  private connect(): void {
    if (this.sealed) return;
    const es = new EventSource(this.url, { withCredentials: true });
    this.es = es;
    es.onopen = () => {
      this.refreshedOnce = false;
      connectivity.reportReachable();
      this.subs.forEach((s) => s.onOpen?.(this));
    };
    es.onmessage = (e: MessageEvent) => {
      connectivity.reportReachable();
      const data = e.data as string;
      this.subs.forEach((s) => s.onFrame(data, this));
    };
    es.onerror = () => {
      connectivity.reportUnreachable();
      // Let EventSource self-heal transient drops (readyState CONNECTING). Only act on a FATAL close, and
      // only once — a session refresh + reconnect for an expired access cookie (EventSource never retries
      // a 401). The `this.es !== es` guard ignores a stale closure after we've already moved on.
      if (this.es !== es || es.readyState !== EventSource.CLOSED || this.refreshedOnce || this.sealed) return;
      this.refreshedOnce = true;
      void refreshSession().then((ok) => {
        if (ok && this.es === es && !this.sealed) {
          es.close();
          this.connect();
        }
      });
    };
  }
}

const registry = new Map<string, SharedConnection>();

/**
 * Subscribe to the shared EventSource for `url`. Returns an unsubscribe fn. The connection opens on the
 * first subscriber and closes shortly after the last one detaches (see `IDLE_LINGER_MS`).
 */
export function subscribeSse(url: string, sub: SseSubscriber): () => void {
  let conn = registry.get(url);
  if (!conn) {
    conn = new SharedConnection(url, () => registry.delete(url));
    registry.set(url, conn);
  }
  return conn.add(sub);
}
